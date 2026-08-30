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
const POLL_INTERVAL_MS = Math.max(Number(process.env.POLL_INTERVAL_MS || 900_000), 60_000)

if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  throw new Error('BOT_IDENTIFIER et BOT_PASSWORD sont obligatoires.')
}

const bot = new AtpAgent({ service: BOT_SERVICE })
const registryAgent = new AtpAgent({ service: CERTIFICATION_PDS })

let botDid = null
let trustedVerifiers = new Map()
let handledRecordKeys = new Set()
let announcedSubjectKeys = new Set()
let pollRunning = false
let baselineReady = false
let markerCacheReady = false
let lastSuccessfulPollAt = null
let lastError = null
let lastRegistryCount = 0
let lastMarkerCount = 0
let lastDetectedCertification = null
let lastDecision = null

function normalizeDid(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeHandle(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : ''
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
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

function recordKey(record) {
  return `${record.uri}|${record.cid || record.issuedAt}`
}

function legacyRecordKey(record) {
  return `${record.uri}|${record.issuedAt}`
}

function subjectAnnouncementKey(record) {
  return `${record.status}|${record.subjectDid}`
}

function markerRkey(record) {
  return hash(recordKey(record))
}

async function listAllRecords(agent, repo, collection) {
  const records = []
  let cursor

  do {
    const response = await agent.com.atproto.repo.listRecords({
      repo,
      collection,
      limit: 100,
      cursor,
    })
    records.push(...(response.data.records || []))
    cursor = response.data.cursor
  } while (cursor)

  return records
}

async function listAllCertificationRecords() {
  return (await listAllRecords(registryAgent, CERTIFICATION_REPO, COLLECTION))
    .map(parseCertificationRecord)
    .filter(Boolean)
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

async function loadMarkerCache() {
  handledRecordKeys = new Set()
  announcedSubjectKeys = new Set()

  const markers = await listAllRecords(bot, botDid, MARKER_COLLECTION)
  lastMarkerCount = markers.length

  for (const item of markers) {
    const value = item?.value
    if (!value || typeof value !== 'object') continue

    const certificationUri = typeof value.certificationUri === 'string' ? value.certificationUri : ''
    const certificationCid = typeof value.certificationCid === 'string' ? value.certificationCid : ''
    const issuedAt = typeof value.issuedAt === 'string' ? value.issuedAt : ''
    const status = value.certificationStatus
    const subjectDid = normalizeDid(value.subjectDid)
    const mode = typeof value.mode === 'string' ? value.mode : ''

    if (certificationUri && certificationCid) {
      handledRecordKeys.add(`${certificationUri}|${certificationCid}`)
    }
    if (certificationUri && issuedAt) {
      handledRecordKeys.add(`${certificationUri}|${issuedAt}`)
    }

    if (
      subjectDid &&
      (status === 'certified' || status === 'trusted-verifier') &&
      (mode.startsWith('posted-') || mode === 'announcement-claimed')
    ) {
      announcedSubjectKeys.add(`${status}|${subjectDid}`)
    }
  }

  markerCacheReady = true
  console.log(`[markers] cache chargé : ${markers.length} marqueur(s), ${announcedSubjectKeys.size} compte(s) déjà annoncé(s)`)
}

function recordAlreadyHandled(record) {
  return handledRecordKeys.has(recordKey(record)) || handledRecordKeys.has(legacyRecordKey(record))
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

  handledRecordKeys.add(recordKey(record))
  handledRecordKeys.add(legacyRecordKey(record))
  lastMarkerCount += 1
}

async function claimAnnouncement(record) {
  const key = subjectAnnouncementKey(record)
  if (announcedSubjectKeys.has(key)) return false

  // Le verrou est écrit AVANT le post : après un redémarrage, le même compte
  // ne pourra pas être annoncé une seconde fois, même avec un nouveau CID.
  await writeMarker(record, 'announcement-claimed')
  announcedSubjectKeys.add(key)
  return true
}

function mentionFacet(text, mention, did) {
  const start = text.indexOf(mention)
  if (start < 0 || !did) return null
  return {
    index: {
      byteStart: Buffer.byteLength(text.slice(0, start), 'utf8'),
      byteEnd: Buffer.byteLength(text.slice(0, start + mention.length), 'utf8'),
    },
    features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
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

  return {
    text,
    facets: [
      mentionFacet(text, subjectMention, record.subjectDid),
      mentionFacet(text, verifierMention, verifier.did),
    ].filter(Boolean),
  }
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

  return {
    text,
    facets: [mentionFacet(text, subjectMention, record.subjectDid)].filter(Boolean),
  }
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

async function initializePersistentBaseline(records) {
  let created = 0
  let existing = 0

  for (const record of records) {
    if (recordAlreadyHandled(record)) {
      existing += 1
      continue
    }
    await writeMarker(record, 'baseline')
    created += 1
  }

  baselineReady = true
  console.log(`[baseline] prêt : ${created} nouveau(x) marqueur(s), ${existing} déjà connu(s)`)
}

async function suppressDuplicate(record) {
  await writeMarker(record, 'duplicate-suppressed')
  lastDecision = {
    action: 'duplicate-suppressed',
    subjectHandle: record.subjectHandle,
    status: record.status,
    at: new Date().toISOString(),
  }
  console.log(`[duplicate] @${record.subjectHandle} déjà annoncé, aucune republication`)
}

async function processTrustedVerifier(record) {
  if (announcedSubjectKeys.has(subjectAnnouncementKey(record))) {
    return suppressDuplicate(record)
  }

  try {
    if (!(await claimAnnouncement(record))) return suppressDuplicate(record)
    const { text, facets } = buildTrustedVerifierAnnouncement(record)
    const postUri = await publishPost(text, facets)

    lastDetectedCertification = {
      type: 'trusted-verifier',
      subjectHandle: record.subjectHandle,
      postUri,
      detectedAt: new Date().toISOString(),
    }
    lastDecision = { action: 'posted-trusted-verifier', ...lastDetectedCertification }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    lastDecision = { action: 'error-trusted-verifier', subjectHandle: record.subjectHandle, error: lastError }
    console.error(`[post] échec annonce certificateur @${record.subjectHandle}:`, lastError)
  }
}

async function processCertification(record) {
  const verifier = trustedVerifiers.get(record.issuerDid)
  if (!verifier) {
    await writeMarker(record, 'ignored-untrusted-issuer')
    lastDecision = {
      action: 'ignored',
      reason: 'issuer-not-trusted-verifier',
      subjectHandle: record.subjectHandle,
      issuerDid: record.issuerDid,
      at: new Date().toISOString(),
    }
    return
  }

  if (announcedSubjectKeys.has(subjectAnnouncementKey(record))) {
    return suppressDuplicate(record)
  }

  try {
    if (!(await claimAnnouncement(record))) return suppressDuplicate(record)
    const { text, facets } = buildCertificationAnnouncement(record, verifier)
    const postUri = await publishPost(text, facets)

    lastDetectedCertification = {
      type: 'certified',
      subjectHandle: record.subjectHandle,
      issuerHandle: verifier.handle,
      postUri,
      detectedAt: new Date().toISOString(),
    }
    lastDecision = { action: 'posted-certification', ...lastDetectedCertification }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    lastDecision = { action: 'error-certification', subjectHandle: record.subjectHandle, error: lastError }
    console.error(`[post] échec pour @${record.subjectHandle}:`, lastError)
  }
}

async function processRecords(records) {
  const orderedRecords = [...records].sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))

  for (const record of orderedRecords) {
    if (recordAlreadyHandled(record)) continue
    if (record.status === 'trusted-verifier') await processTrustedVerifier(record)
    else await processCertification(record)
  }
}

async function poll() {
  if (pollRunning) return
  pollRunning = true

  try {
    const records = await listAllCertificationRecords()
    lastRegistryCount = records.length
    rebuildTrustedVerifierRegistry(records)

    if (!baselineReady) await initializePersistentBaseline(records)
    else await processRecords(records)

    lastSuccessfulPollAt = new Date().toISOString()
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[poll] erreur:', lastError)
  } finally {
    pollRunning = false
  }
}

async function start() {
  await bot.login({ identifier: BOT_IDENTIFIER, password: BOT_PASSWORD })
  botDid = bot.session?.did || null
  if (!botDid) throw new Error('Impossible de récupérer le DID du bot.')

  console.log(`[bot] connecté: ${BOT_IDENTIFIER} (${botDid})`)
  console.log(`[registry] ${CERTIFICATION_REPO} / ${COLLECTION} via ${CERTIFICATION_PDS}`)
  console.log(`[poll] intervalle: ${POLL_INTERVAL_MS} ms`)

  await loadMarkerCache()
  await poll()

  setInterval(() => {
    poll().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error)
      console.error('[poll] erreur non gérée:', lastError)
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
    markerVersion: 'memory-cache+subject-lock-v2',
    markerCacheReady,
    markerCount: lastMarkerCount,
    baselineReady,
    announcedSubjectCount: announcedSubjectKeys.size,
    trustedVerifierCount: trustedVerifiers.size,
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
    markerCacheReady,
    baselineReady,
    markerVersion: 'memory-cache+subject-lock-v2',
    announcedSubjectCount: announcedSubjectKeys.size,
    trustedVerifierCount: trustedVerifiers.size,
    pollIntervalMs: POLL_INTERVAL_MS,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[http] écoute sur le port ${PORT}`)
})

start().catch((error) => {
  lastError = error instanceof Error ? error.message : String(error)
  console.error('[startup] échec du démarrage:', lastError)
  process.exitCode = 1
})
