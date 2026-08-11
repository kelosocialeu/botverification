import 'dotenv/config'
import express from 'express'
import { AtpAgent } from '@atproto/api'

const COLLECTION = 'eu.kelosocial.certification'
const CERTIFICATION_REPO = process.env.CERTIFICATION_REPO || 'kelosocial.eu'
const CERTIFICATION_PDS = process.env.CERTIFICATION_PDS || 'https://eurosky.social'
const PUBLIC_APPVIEW = process.env.PUBLIC_APPVIEW || 'https://public.api.bsky.app'
const BOT_SERVICE = process.env.BOT_SERVICE || 'https://pds.kelosocial.eu'
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER
const BOT_PASSWORD = process.env.BOT_PASSWORD
const PORT = Number(process.env.PORT || 3000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)
const STARTUP_GRACE_MS = Number(process.env.STARTUP_GRACE_MS || 300_000)

if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  throw new Error('BOT_IDENTIFIER et BOT_PASSWORD sont obligatoires.')
}

const bot = new AtpAgent({ service: BOT_SERVICE })
const registryAgent = new AtpAgent({ service: CERTIFICATION_PDS })
const publicAgent = new AtpAgent({ service: PUBLIC_APPVIEW })

const seenCertificationUris = new Set()
const processStartedAt = Date.now()

let botDid = null
let trustedVerifiers = new Map()
let lastSuccessfulPollAt = null
let lastError = null
let lastRegistryCount = 0

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
    cid: item.cid || null,
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
    })
  }

  trustedVerifiers = next

  console.log(
    `[registry] ${trustedVerifiers.size} certificateur(s) de confiance détecté(s) automatiquement`,
  )
}

function isRecentEnough(record) {
  const issuedAt = Date.parse(record.issuedAt)
  if (!Number.isFinite(issuedAt)) return false
  return issuedAt >= processStartedAt - STARTUP_GRACE_MS
}

async function getProfileLabel(did, fallbackHandle) {
  try {
    const profile = await publicAgent.getProfile({ actor: did })
    if (profile.data.displayName?.trim()) {
      return `${profile.data.displayName.trim()} (@${profile.data.handle})`
    }
    return `@${profile.data.handle}`
  } catch {
    return fallbackHandle ? `@${fallbackHandle}` : did
  }
}

async function buildAnnouncement(record, verifier) {
  const verifierLabel = await getProfileLabel(verifier.did, verifier.handle)
  const subjectLabel = await getProfileLabel(record.subjectDid, record.subjectHandle)

  return `✅ Nouvelle certification Kelo Social\n\n${subjectLabel} vient d’être certifié par ${verifierLabel}.\n\nCertification délivrée par un certificateur de confiance Kelo Social.`
}

async function publishAnnouncement(record, verifier) {
  const text = await buildAnnouncement(record, verifier)

  const response = await bot.post({
    text,
    createdAt: new Date().toISOString(),
    langs: ['fr'],
  })

  console.log(`[post] annonce publiée: ${response.uri}`)
  return response.uri
}

async function processCertifiedRecords(records) {
  // Du plus ancien au plus récent pour conserver l'ordre des annonces.
  const certifiedRecords = records
    .filter((record) => record.status === 'certified')
    .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))

  for (const record of certifiedRecords) {
    if (seenCertificationUris.has(record.uri)) continue

    // Au démarrage, on mémorise l'historique ancien sans le republier.
    if (!isRecentEnough(record)) {
      seenCertificationUris.add(record.uri)
      continue
    }

    // Le certificateur est découvert exclusivement depuis les records
    // status="trusted-verifier" du registre AT Protocol Kelo Social.
    const verifier = trustedVerifiers.get(record.issuerDid)

    if (!verifier) {
      console.log(
        `[ignore] ${record.subjectHandle}: émetteur ${record.issuerDid || record.issuerHandle || 'inconnu'} non reconnu comme certificateur de confiance`,
      )
      seenCertificationUris.add(record.uri)
      continue
    }

    try {
      await publishAnnouncement(record, verifier)
      seenCertificationUris.add(record.uri)
      console.log(
        `[certification] @${verifier.handle} a certifié @${record.subjectHandle}`,
      )
    } catch (error) {
      console.error(`[post] échec pour ${record.uri}:`, error.message)
      // Pas marqué comme vu : nouvel essai au prochain passage.
    }
  }
}

async function poll() {
  try {
    const records = await listAllCertificationRecords()
    lastRegistryCount = records.length

    // Toujours reconstruire la liste depuis AT Protocol pour qu'un nouveau
    // certificateur de confiance soit détecté sans configuration Render.
    rebuildTrustedVerifierRegistry(records)
    await processCertifiedRecords(records)

    lastSuccessfulPollAt = new Date().toISOString()
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    console.error('[poll] erreur:', error)
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
    lastSuccessfulPollAt,
    lastError,
  })
})

app.get('/health', (_req, res) => {
  res.status(lastError ? 503 : 200).json({
    ok: !lastError,
    trustedVerifierCount: trustedVerifiers.size,
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
