import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import { AtpAgent } from '@atproto/api'

const COLLECTION = 'eu.kelosocial.certification'
const MARKER_COLLECTION = 'eu.kelosocial.botverification.seen'
const CERTIFICATION_REPO = process.env.CERTIFICATION_REPO || 'kelosocial.eu'
const CERTIFICATION_PDS = process.env.CERTIFICATION_PDS || 'https://eurosky.social'
const BOT_SERVICE = process.env.BOT_SERVICE || 'https://eurosky.social'
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER
const BOT_PASSWORD = process.env.BOT_PASSWORD
const PORT = Number(process.env.PORT || 3000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)

if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  throw new Error('BOT_IDENTIFIER et BOT_PASSWORD sont obligatoires.')
}

const bot = new AtpAgent({ service: BOT_SERVICE })
const registryAgent = new AtpAgent({ service: CERTIFICATION_PDS })

let botDid = null
let trustedVerifiers = new Map()
let pollRunning = false
let baselineReady = false
let lastSuccessfulPollAt = null
let lastError = null
let lastRegistryCount = 0
let lastDetectedCertification = null
let lastDecision = null

function normalizeDid(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeHandle(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^@/, '').toLowerCase()
    : ''
}

function parseCertificationRecord(item) {
  if (!item?.uri || !item?.value || typeof item.value !== 'object') return null

  const value = item.value
  const subjectDid = normalizeDid(value.subjectDid)
  const subjectHandle = normalizeHandle(value.subjectHandle)
  const issuerDid = normalizeDid(value.issuerDid)
  const issuerHandle = normalizeHandle(value.issuerHandle)
  const issuedAt = typeof value.issuedAt === 'string' ? value.issuedAt : ''

  if (!subjectDid || !subjectHandle || !issuedAt) return null
  if (value.status !== 'certified' && value.status !== 'trusted-verifier') return null

  return {
    uri: item.uri,
    cid: typeof item.cid === 'string' ? item.cid : '',
    status: value.status,
    subjectDid,
    subjectHandle,
    issuerDid,
    issuerHandle,
    issuedAt,
  }
}

async function listAllCertificationRecords() {
  const records = []
  let cursor

  do {
    const response = await registryAgent.com.atproto.repo.listRecords({
      repo: CERTIFICATION_REPO,
      collection: COLLECTION,
      limit: 100,
      cursor,
    })

    records.push(...(response.data.records || []))
    cursor = response.data.cursor
  } while (cursor)

  return records.map(parseCertificationRecord).filter(Boolean)
}

function rebuildTrustedVerifierRegistry(records) {
  const next = new Map()

  for (const record of records) {
    if (record.status !== 'trusted-verifier') continue
    next.set(record.subjectDid, {
      did: record.subjectDid,
      handle: record.subjectHandle,
      issuedAt: record.issuedAt,
    })
  }

  trustedVerifiers = next
  console.log(`[registry] ${trustedVerifiers.size} certificateur(s) de confiance détecté(s)`)
}

function legacyMarkerRkey(record) {
  return crypto
    .createHash('sha256')
    .update(`${record.uri}|${record.issuedAt}`)
    .digest('hex')
}

function markerRkey(record) {
  return crypto
    .createHash('sha256')
    .update(`${record.uri}|${record.cid || record.issuedAt}`)
    .digest('hex')
}

async function getMarkerByRkey(rkey) {
  if (!botDid) return null

  try {
    const response = await bot.com.atproto.repo.getRecord({
      repo: botDid,
      collection: MARKER_COLLECTION,
      rkey,
    })
    return response.data.value || null
  } catch {
    return null
  }
}

async function recordAlreadyHandled(record) {
  if (await getMarkerByRkey(markerRkey(record))) return true

  const legacy = await getMarkerByRkey(legacyMarkerRkey(record))
  if (!legacy) return false

  return typeof legacy.certificationCid === 'string' && legacy.certificationCid === record.cid
}

async function writeMarker(record, mode, postUri = '') {
  if (!botDid) throw new Error('DID du bot indisponible.')

  await bot.com.atproto.repo.putRecord({
    repo: botDid,
    collection: MARKER_COLLECTION,
    rkey: markerRkey(record),
    validate: false,
    record: {
      $type: MARKER_COLLECTION,
      certificationUri: record.uri,
      certificationCid: record.cid,
      certificationStatus: record.status,
      subjectDid: record.subjectDid,
      subjectHandle: record.subjectHandle,
      issuerDid: record.issuerDid,
      issuerHandle: record.issuerHandle,
      issuedAt: record.issuedAt,
      mode,
      postUri,
      recordedAt: new Date().toISOString(),
    },
  })
}

function mentionFacet(text, mention, did, fromIndex = 0) {
  const start = text.indexOf(mention, fromIndex)
  if (start < 0 || !did) return null

  return {
    index: {
      byteStart: Buffer.byteLength(text.slice(0, start), 'utf8'),
      byteEnd: Buffer.byteLength(text.slice(0, start + mention.length), 'utf8'),
    },
    features: [
      {
        $type: 'app.bsky.richtext.facet#mention',
        did,
      },
    ],
  }
}

function buildCertificationAnnouncement(record, verifier) {
  const subjectMention = `@${record.subjectHandle}`
  const verifierMention = `@${verifier.handle}`

  const text = [
    '✅ Certification accordée',
    '',
    `${subjectMention} vient d’obtenir une certification sur Kelo Social.`,
    '',
    `Certification attribuée par ${verifierMention}, certificateur de confiance Kelo Social.`,
  ].join('\n')

  const facets = [
    mentionFacet(text, subjectMention, record.subjectDid),
    mentionFacet(text, verifierMention, verifier.did),
  ].filter(Boolean)

  return { text, facets }
}

function buildTrustedVerifierAnnouncement(record) {
  const subjectMention = `@${record.subjectHandle}`

  const text = [
    '🌟 Nouveau certificateur de confiance',
    '',
    `${subjectMention} rejoint les certificateurs de confiance de Kelo Social.`,
    '',
    'Ce compte peut désormais attribuer des certifications aux comptes éligibles sur Kelo Social.',
  ].join('\n')

  const facets = [
    mentionFacet(text, subjectMention, record.subjectDid),
  ].filter(Boolean)

  return { text, facets }
}

async function publishPost(text, facets) {
  const response = await bot.post({
    text,
    facets,
    createdAt: new Date().toISOString(),
    langs: ['fr'],
  })

  console.log(`[post] annonce publiée: ${response.uri}`)
  return response.uri
}

async function publishCertificationAnnouncement(record, verifier) {
  const { text, facets } = buildCertificationAnnouncement(record, verifier)
  return publishPost(text, facets)
}

async function publishTrustedVerifierAnnouncement(record) {
  const { text, facets } = buildTrustedVerifierAnnouncement(record)
  return publishPost(text, facets)
}

async function initializePersistentBaseline(records) {
  let created = 0
  let existing = 0

  for (const record of records) {
    if (await recordAlreadyHandled(record)) {
      existing += 1
      continue
    }

    await writeMarker(record, 'baseline')
    created += 1
  }

  baselineReady = true
  console.log(`[baseline] prêt : ${created} marqueur(s) créé(s), ${existing} déjà présent(s)`)
}

async function processRecords(records) {
  const orderedRecords = [...records].sort(
    (a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt),
  )

  for (const record of orderedRecords) {
    if (await recordAlreadyHandled(record)) continue

    if (record.status === 'trusted-verifier') {
      console.log(`[detect] nouveau certificateur de confiance @${record.subjectHandle}`)

      try {
        const postUri = await publishTrustedVerifierAnnouncement(record)
        await writeMarker(record, 'posted-trusted-verifier', postUri)

        lastDetectedCertification = {
          type: 'trusted-verifier',
          subjectHandle: record.subjectHandle,
          recordUri: record.uri,
          recordCid: record.cid,
          postUri,
          detectedAt: new Date().toISOString(),
        }
        lastDecision = { action: 'posted-trusted-verifier', ...lastDetectedCertification }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        lastDecision = {
          action: 'error-trusted-verifier',
          subjectHandle: record.subjectHandle,
          recordCid: record.cid,
          error: lastError,
          at: new Date().toISOString(),
        }
        console.error(`[post] échec annonce certificateur @${record.subjectHandle}:`, error?.message || error)
      }

      continue
    }

    const verifier = trustedVerifiers.get(record.issuerDid)

    if (!verifier) {
      lastDecision = {
        action: 'ignored',
        reason: 'issuer-not-trusted-verifier',
        subjectHandle: record.subjectHandle,
        issuerDid: record.issuerDid,
        issuerHandle: record.issuerHandle,
        recordCid: record.cid,
        at: new Date().toISOString(),
      }
      console.log(
        `[ignore] @${record.subjectHandle}: ${record.issuerDid || record.issuerHandle || 'émetteur inconnu'} n'est pas un certificateur de confiance`,
      )
      continue
    }

    console.log(
      `[detect] @${verifier.handle} a certifié @${record.subjectHandle} (CID ${record.cid})`,
    )

    try {
      const postUri = await publishCertificationAnnouncement(record, verifier)
      await writeMarker(record, 'posted-certification', postUri)

      lastDetectedCertification = {
        type: 'certified',
        subjectHandle: record.subjectHandle,
        issuerHandle: verifier.handle,
        recordUri: record.uri,
        recordCid: record.cid,
        postUri,
        detectedAt: new Date().toISOString(),
      }
      lastDecision = { action: 'posted-certification', ...lastDetectedCertification }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastDecision = {
        action: 'error-certification',
        subjectHandle: record.subjectHandle,
        issuerHandle: verifier.handle,
        recordCid: record.cid,
        error: lastError,
        at: new Date().toISOString(),
      }
      console.error(`[post] échec pour @${record.subjectHandle}:`, error?.message || error)
    }
  }
}

async function poll() {
  if (pollRunning) return
  pollRunning = true

  try {
    const records = await listAllCertificationRecords()
    lastRegistryCount = records.length
    rebuildTrustedVerifierRegistry(records)

    if (!baselineReady) {
      await initializePersistentBaseline(records)
    } else {
      await processRecords(records)
    }

    lastSuccessfulPollAt = new Date().toISOString()
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[poll] erreur:', error)
  } finally {
    pollRunning = false
  }
}

async function start() {
  await bot.login({ identifier: BOT_IDENTIFIER, password: BOT_PASSWORD })
  botDid = bot.session?.did || null

  console.log(`[bot] connecté: ${BOT_IDENTIFIER}${botDid ? ` (${botDid})` : ''}`)
  console.log(`[registry] ${CERTIFICATION_REPO} / ${COLLECTION} via ${CERTIFICATION_PDS}`)
  console.log(`[markers] ${MARKER_COLLECTION} sur le dépôt du bot`)

  await poll()

  setInterval(() => {
    poll().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error)
      console.error('[poll] erreur non gérée:', error)
    })
  }, POLL_INTERVAL_MS)
}

const app = express()

app.get('/', (_req, res) => {
  res.json({
    service: 'Kelo Certification Bot',
    status: lastError ? 'degraded' : 'ok',
    bot: BOT_IDENTIFIER,
    botDid,
    registry: {
      repo: CERTIFICATION_REPO,
      pds: CERTIFICATION_PDS,
      collection: COLLECTION,
      recordCount: lastRegistryCount,
    },
    markerCollection: MARKER_COLLECTION,
    markerVersion: 'uri+cid',
    baselineReady,
    trustedVerifierCount: trustedVerifiers.size,
    trustedVerifiers: [...trustedVerifiers.values()],
    pollIntervalMs: POLL_INTERVAL_MS,
    pollRunning,
    lastDetectedCertification,
    lastDecision,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.get('/health', (_req, res) => {
  res.status(lastError ? 503 : 200).json({
    ok: !lastError,
    baselineReady,
    markerVersion: 'uri+cid',
    trustedVerifierCount: trustedVerifiers.size,
    lastDetectedCertification,
    lastDecision,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[http] écoute sur le port ${PORT}`)
})

start().catch((error) => {
  lastError = error instanceof Error ? error.message : String(error)
  console.error('[startup] échec du démarrage:', error)
  process.exitCode = 1
})
