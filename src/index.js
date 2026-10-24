import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import { AtpAgent } from '@atproto/api'

const COLLECTION = 'eu.kelosocial.certification'
const MARKER_COLLECTION = 'eu.kelosocial.botverification.seen'
const CERTIFICATION_REPO = process.env.CERTIFICATION_REPO || 'kelosocial.eu'
const CERTIFICATION_PDS = process.env.CERTIFICATION_PDS || 'https://pds.kelosocial.eu'
const CERTIFICATION_PDS_CANDIDATES = [...new Set([
  CERTIFICATION_PDS,
  ...(process.env.CERTIFICATION_PDS_FALLBACKS || 'https://pds.kelosocial.eu,https://eurosky.social')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
])]
let activeCertificationPds = CERTIFICATION_PDS
const BOT_SERVICE = process.env.BOT_SERVICE || 'https://eurosky.social'
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER
const BOT_PASSWORD = process.env.BOT_PASSWORD
const PORT = Number(process.env.PORT || 3000)
const POLL_INTERVAL_MS = Math.max(Number(process.env.POLL_INTERVAL_MS || 2_000), 2_000)
const JETSTREAM_URL = process.env.JETSTREAM_URL || 'wss://jetstream.us-east.bsky.network/subscribe'

if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  throw new Error('BOT_IDENTIFIER et BOT_PASSWORD sont obligatoires.')
}

const bot = new AtpAgent({ service: BOT_SERVICE })

let botDid = null
let trustedVerifiers = new Map()
let handledRecordKeys = new Set()
let announcedSubjectKeys = new Set()
let pollRunning = false
let pollRequested = false
let jetstreamSocket = null
let jetstreamReconnectTimer = null
let baselineReady = false
let markerCacheReady = false
let lastSuccessfulPollAt = null
let lastError = null
let lastRegistryCount = 0
let lastRawRegistryCount = 0
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
  // Accepte les variantes de champs déjà utilisées par les versions du registre.
  const subjectDid = normalizeDid(value.subjectDid || value.did || value.verifierDid || value.accountDid)
  const subjectHandle = normalizeHandle(value.subjectHandle || value.handle || value.verifierHandle || value.accountHandle)
  const issuerDid = normalizeDid(value.issuerDid || value.certifierDid || value.issuedByDid)
  const issuerHandle = normalizeHandle(value.issuerHandle || value.certifierHandle || value.issuedByHandle)
  const issuedAt = [
    value.issuedAt, value.createdAt, value.certifiedAt, value.updatedAt, value.timestamp,
  ].find((candidate) => typeof candidate === 'string' && candidate.length > 0) || ''
  const rawStatus = String(value.status || value.type || value.kind || '').toLowerCase()
  const status = ['trusted-verifier', 'trusted_verifier', 'trustedverifier', 'trusted-certifier', 'trusted_certifier'].includes(rawStatus)
    ? 'trusted-verifier'
    : ['certified', 'certification', 'verified'].includes(rawStatus)
      ? 'certified'
      : ''

  if (!subjectDid || !subjectHandle || !issuedAt || !status) return null

  return {
    uri: item.uri,
    cid: typeof item.cid === 'string' ? item.cid : '',
    status,
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
  let lastEmptyResult = []
  let lastFailure = null

  // Le compte du registre peut être hébergé sur un PDS différent de celui du bot.
  // On essaie le PDS configuré puis les replis, et on privilégie le premier qui contient des records.
  for (const pds of CERTIFICATION_PDS_CANDIDATES) {
    try {
      const agent = new AtpAgent({ service: pds })
      const rawRecords = await listAllRecords(agent, CERTIFICATION_REPO, COLLECTION)
      if (rawRecords.length > 0) {
        activeCertificationPds = pds
        lastRawRegistryCount = rawRecords.length
        const parsedRecords = rawRecords.map(parseCertificationRecord).filter(Boolean)
        console.log(`[registry] lecture réussie via ${pds}: ${rawRecords.length} record(s) brut(s), ${parsedRecords.length} certification(s) reconnue(s)`)
        if (parsedRecords.length === 0) {
          console.warn(`[registry] aucun record ne correspond au schéma reconnu dans ${COLLECTION}; champs attendus: sujet, statut et date`)
        }
        return parsedRecords
      }
      lastEmptyResult = rawRecords
      activeCertificationPds = pds
      console.log(`[registry] aucun record via ${pds}; essai du PDS suivant si disponible`)
    } catch (error) {
      lastFailure = error
      console.warn(`[registry] lecture impossible via ${pds}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (lastFailure && lastEmptyResult.length === 0) throw lastFailure
  lastRawRegistryCount = lastEmptyResult.length
  console.log(`[registry] aucun record trouvé sur les PDS testés: ${CERTIFICATION_PDS_CANDIDATES.join(', ')}`)
  return []
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
  // Un cache persistant existant signifie que le bot a déjà effectué son premier scan.
  // Ne jamais reclasser les records apparus pendant un arrêt comme faisant partie de la baseline.
  baselineReady = markers.length > 0 || markers.some((item) => item?.value?.mode === 'baseline-initialized')

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

  // Marqueur de bootstrap séparé : même un registre vide ne doit être initialisé
  // qu'une seule fois. Les records ajoutés ensuite seront donc publiés après détection.
  await bot.com.atproto.repo.putRecord({
    repo: botDid,
    collection: MARKER_COLLECTION,
    rkey: 'baseline-v1',
    validate: false,
    record: {
      $type: MARKER_COLLECTION,
      mode: 'baseline-initialized',
      recordedAt: new Date().toISOString(),
    },
  })
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
    await writeMarker(record, 'posted-trusted-verifier', postUri)
    announcedSubjectKeys.add(subjectAnnouncementKey(record))

    lastDetectedCertification = {
      type: 'trusted-verifier',
      subjectHandle: record.subjectHandle,
      postUri,
      detectedAt: new Date().toISOString(),
    }
    lastDecision = { action: 'posted-trusted-verifier', ...lastDetectedCertification }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    announcedSubjectKeys.delete(subjectAnnouncementKey(record))
    lastDecision = { action: 'error-trusted-verifier', subjectHandle: record.subjectHandle, error: lastError }
    console.error(`[post] échec annonce certificateur @${record.subjectHandle}:`, lastError)
  }
}

async function processCertification(record) {
  const verifier = trustedVerifiers.get(record.issuerDid)
  if (!verifier) {
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
    await writeMarker(record, 'posted-certification', postUri)
    announcedSubjectKeys.add(subjectAnnouncementKey(record))

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
    announcedSubjectKeys.delete(subjectAnnouncementKey(record))
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
  if (pollRunning) {
    pollRequested = true
    return
  }
  pollRunning = true
  lastError = null

  try {
    const records = await listAllCertificationRecords()
    lastRegistryCount = records.length
    rebuildTrustedVerifierRegistry(records)

    if (!baselineReady) await initializePersistentBaseline(records)
    else await processRecords(records)

    lastSuccessfulPollAt = new Date().toISOString()
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[poll] erreur:', lastError)
  } finally {
    pollRunning = false
    if (pollRequested) {
      pollRequested = false
      queueMicrotask(() => poll().catch((error) => {
        lastError = error instanceof Error ? error.message : String(error)
        console.error('[poll] erreur après demande en attente:', lastError)
      }))
    }
  }
}

function connectJetstream() {
  if (jetstreamSocket && (jetstreamSocket.readyState === WebSocket.OPEN || jetstreamSocket.readyState === WebSocket.CONNECTING)) return

  try {
    const url = new URL(JETSTREAM_URL)
    url.searchParams.append('wantedCollections', COLLECTION)
    jetstreamSocket = new WebSocket(url)

    jetstreamSocket.addEventListener('open', () => {
      console.log(`[jetstream] connecté à ${url.origin}; écoute de ${COLLECTION}`)
    })

    jetstreamSocket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data?.kind !== 'commit') return
        if (data?.commit?.operation === 'delete') return
        if (data?.commit?.collection !== COLLECTION) return

        console.log(`[jetstream] événement ${data.commit.operation || 'commit'} détecté pour ${data.commit.collection}; scan immédiat`)
        poll().catch((error) => {
          lastError = error instanceof Error ? error.message : String(error)
          console.error('[jetstream] scan immédiat échoué:', lastError)
        })
      } catch (error) {
        console.warn('[jetstream] événement illisible:', error instanceof Error ? error.message : String(error))
      }
    })

    jetstreamSocket.addEventListener('error', () => {
      console.error('[jetstream] erreur de connexion; reconnexion programmée')
      try { jetstreamSocket?.close() } catch {}
    })

    jetstreamSocket.addEventListener('close', () => {
      jetstreamSocket = null
      if (jetstreamReconnectTimer) clearTimeout(jetstreamReconnectTimer)
      jetstreamReconnectTimer = setTimeout(connectJetstream, 5_000)
      console.warn('[jetstream] connexion fermée; nouvelle tentative dans 5 secondes')
    })
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[jetstream] connexion impossible:', lastError)
    jetstreamReconnectTimer = setTimeout(connectJetstream, 5_000)
  }
}

async function start() {
  await bot.login({ identifier: BOT_IDENTIFIER, password: BOT_PASSWORD })
  botDid = bot.session?.did || null
  if (!botDid) throw new Error('Impossible de récupérer le DID du bot.')

  console.log(`[bot] connecté: ${BOT_IDENTIFIER} (${botDid})`)
  console.log(`[registry] ${CERTIFICATION_REPO} / ${COLLECTION}; PDS testés: ${CERTIFICATION_PDS_CANDIDATES.join(', ')}`)
  console.log(`[poll] intervalle: ${POLL_INTERVAL_MS} ms (détection quasi immédiate)`)

  await loadMarkerCache()
  await poll()

  // Le flux événementiel publie dès l'arrivée d'un commit; le scan périodique
  // reste actif comme filet de sécurité en cas d'indisponibilité du flux.
  connectJetstream()

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
      pds: activeCertificationPds,
      pdsCandidates: CERTIFICATION_PDS_CANDIDATES,
      collection: COLLECTION,
      recordCount: lastRegistryCount,
      rawRecordCount: lastRawRegistryCount,
    },
    markerCollection: MARKER_COLLECTION,
    markerVersion: 'persistent-baseline+subject-lock-v3',
    markerCacheReady,
    markerCount: lastMarkerCount,
    baselineReady,
    announcedSubjectCount: announcedSubjectKeys.size,
    trustedVerifierCount: trustedVerifiers.size,
    pollIntervalMs: POLL_INTERVAL_MS,
    jetstreamUrl: JETSTREAM_URL,
    jetstreamConnected: Boolean(jetstreamSocket && jetstreamSocket.readyState === WebSocket.OPEN),
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
    rawRecordCount: lastRawRegistryCount,
    parsedCertificationCount: lastRegistryCount,
    baselineReady,
    markerVersion: 'persistent-baseline+subject-lock-v3',
    announcedSubjectCount: announcedSubjectKeys.size,
    trustedVerifierCount: trustedVerifiers.size,
    pollIntervalMs: POLL_INTERVAL_MS,
    jetstreamConnected: Boolean(jetstreamSocket && jetstreamSocket.readyState === WebSocket.OPEN),
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
