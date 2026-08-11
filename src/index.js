import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import { AtpAgent } from '@atproto/api'

const COLLECTION = 'eu.kelosocial.certification'
const POST_COLLECTION = 'app.bsky.feed.post'
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

// URI -> dernier CID observé pendant la vie du processus.
const seenRecordCids = new Map()
let initialSnapshotDone = false
let pollRunning = false

let botDid = null
let trustedVerifiers = new Map()
let lastSuccessfulPollAt = null
let lastError = null
let lastRegistryCount = 0
let lastDetectedCertification = null

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
      uri: record.uri,
      cid: record.cid,
    })
  }

  trustedVerifiers = next
  console.log(`[registry] ${trustedVerifiers.size} certificateur(s) de confiance détecté(s) automatiquement`)
}

function announcementRkey(record) {
  // Une certification Kelo possède une URI ATProto stable et unique.
  // Le hash de cette URI devient la rkey du post du bot : même après un
  // redémarrage ou avec deux instances simultanées, la même certification
  // ne peut pas créer plusieurs posts.
  return crypto.createHash('sha256').update(record.uri).digest('hex')
}

function mentionFacet(text, mention, did) {
  const start = text.indexOf(mention)
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

function buildAnnouncement(record, verifier) {
  const subjectMention = `@${record.subjectHandle}`
  const verifierMention = `@${verifier.handle}`

  const text = [
    '✅ Nouveau compte certifié',
    '',
    `${subjectMention} a reçu une certification sur Kelo Social, attribuée par ${verifierMention}.`,
    '',
    'Cette certification a été délivrée par un certificateur de confiance reconnu par Kelo Social.',
  ].join('\n')

  const facets = [
    mentionFacet(text, subjectMention, record.subjectDid),
    mentionFacet(text, verifierMention, verifier.did),
  ].filter(Boolean)

  return { text, facets }
}

async function postAlreadyExists(rkey) {
  if (!botDid) return false

  try {
    await bot.com.atproto.repo.getRecord({
      repo: botDid,
      collection: POST_COLLECTION,
      rkey,
    })
    return true
  } catch (error) {
    const status = error?.status || error?.response?.status
    if (status === 400 || status === 404) return false
    return false
  }
}

async function publishAnnouncement(record, verifier) {
  if (!botDid) throw new Error('DID du bot indisponible.')

  const rkey = announcementRkey(record)

  if (await postAlreadyExists(rkey)) {
    console.log(`[duplicate] annonce déjà publiée pour ${record.uri}`)
    return { duplicate: true, uri: `at://${botDid}/${POST_COLLECTION}/${rkey}` }
  }

  const { text, facets } = buildAnnouncement(record, verifier)

  try {
    const response = await bot.com.atproto.repo.createRecord({
      repo: botDid,
      collection: POST_COLLECTION,
      rkey,
      record: {
        $type: POST_COLLECTION,
        text,
        facets,
        createdAt: new Date().toISOString(),
        langs: ['fr'],
      },
    })

    console.log(`[post] annonce publiée: ${response.data.uri}`)
    return { duplicate: false, uri: response.data.uri }
  } catch (error) {
    // Protection supplémentaire contre les courses entre deux instances :
    // si une autre instance a créé la rkey juste avant nous, on considère
    // simplement l'annonce comme déjà publiée.
    if (await postAlreadyExists(rkey)) {
      console.log(`[duplicate] annonce créée par une autre instance pour ${record.uri}`)
      return { duplicate: true, uri: `at://${botDid}/${POST_COLLECTION}/${rkey}` }
    }
    throw error
  }
}

function seedInitialSnapshot(records) {
  for (const record of records) {
    seenRecordCids.set(record.uri, record.cid)
  }
  initialSnapshotDone = true
  console.log(`[snapshot] ${records.length} record(s) existant(s) mémorisé(s)`)
}

async function processCertifiedRecords(records) {
  if (!initialSnapshotDone) {
    seedInitialSnapshot(records)
    return
  }

  const certifiedRecords = records
    .filter((record) => record.status === 'certified')
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))

  for (const record of certifiedRecords) {
    const previousCid = seenRecordCids.get(record.uri)
    if (previousCid === record.cid) continue

    const verifier = trustedVerifiers.get(record.issuerDid)

    if (!verifier) {
      console.log(
        `[ignore] @${record.subjectHandle}: émetteur ${record.issuerDid || record.issuerHandle || 'inconnu'} non reconnu comme certificateur de confiance`,
      )
      seenRecordCids.set(record.uri, record.cid)
      continue
    }

    try {
      const result = await publishAnnouncement(record, verifier)
      seenRecordCids.set(record.uri, record.cid)
      lastDetectedCertification = {
        subjectHandle: record.subjectHandle,
        issuerHandle: verifier.handle,
        recordUri: record.uri,
        recordCid: record.cid,
        postUri: result.uri,
        duplicatePrevented: result.duplicate,
        detectedAt: new Date().toISOString(),
      }
      console.log(
        `[certification] @${verifier.handle} a certifié @${record.subjectHandle} (CID ${record.cid})`,
      )
    } catch (error) {
      console.error(`[post] échec pour ${record.uri}:`, error?.message || error)
    }
  }
}

async function poll() {
  if (pollRunning) {
    console.log('[poll] passage ignoré : scan précédent toujours en cours')
    return
  }

  pollRunning = true

  try {
    const records = await listAllCertificationRecords()
    lastRegistryCount = records.length

    rebuildTrustedVerifierRegistry(records)
    await processCertifiedRecords(records)

    lastSuccessfulPollAt = new Date().toISOString()
    lastError = null
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
    trustedVerifiers: [...trustedVerifiers.values()],
    trustedVerifierCount: trustedVerifiers.size,
    pollIntervalMs: POLL_INTERVAL_MS,
    initialSnapshotDone,
    pollRunning,
    lastDetectedCertification,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.get('/health', (_req, res) => {
  res.status(lastError ? 503 : 200).json({
    ok: !lastError,
    trustedVerifierCount: trustedVerifiers.size,
    initialSnapshotDone,
    pollRunning,
    lastDetectedCertification,
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
