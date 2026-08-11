import 'dotenv/config'
import express from 'express'
import { AtpAgent } from '@atproto/api'

const COLLECTION = 'app.bsky.graph.verification'
const PORT = Number(process.env.PORT || 3000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000)
const STARTUP_GRACE_MS = Number(process.env.STARTUP_GRACE_MS || 300_000)
const PUBLIC_APPVIEW = process.env.PUBLIC_APPVIEW || 'https://public.api.bsky.app'
const BOT_SERVICE = process.env.BOT_SERVICE || 'https://bsky.social'
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER
const BOT_PASSWORD = process.env.BOT_PASSWORD
const TRUSTED_VERIFIERS = (process.env.TRUSTED_VERIFIERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  throw new Error('BOT_IDENTIFIER et BOT_PASSWORD sont obligatoires.')
}

if (TRUSTED_VERIFIERS.length === 0) {
  throw new Error('TRUSTED_VERIFIERS doit contenir au moins un handle ou DID de certificateur.')
}

const bot = new AtpAgent({ service: BOT_SERVICE })
const publicAgent = new AtpAgent({ service: PUBLIC_APPVIEW })
const seenVerificationUris = new Set()
const processStartedAt = Date.now()
let botDid = null
let verifierDids = new Map()
let lastSuccessfulPollAt = null
let lastError = null

async function resolveIdentifier(identifier) {
  if (identifier.startsWith('did:')) return identifier
  const response = await publicAgent.resolveHandle({ handle: identifier })
  return response.data.did
}

async function fetchDidDocument(did) {
  let url

  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${encodeURIComponent(did)}`
  } else if (did.startsWith('did:web:')) {
    const value = did.slice('did:web:'.length)
    const parts = value.split(':').map(decodeURIComponent)
    const host = parts.shift()
    const path = parts.length ? `/${parts.join('/')}/did.json` : '/.well-known/did.json'
    url = `https://${host}${path}`
  } else {
    throw new Error(`Méthode DID non prise en charge: ${did}`)
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/did+ld+json, application/json' },
  })

  if (!response.ok) {
    throw new Error(`Résolution DID impossible (${response.status}) pour ${did}`)
  }

  return response.json()
}

async function resolvePdsEndpoint(did) {
  const document = await fetchDidDocument(did)
  const services = Array.isArray(document.service) ? document.service : []
  const pds = services.find((service) =>
    service?.id?.endsWith('#atproto_pds') || service?.type === 'AtprotoPersonalDataServer'
  )

  if (!pds?.serviceEndpoint || typeof pds.serviceEndpoint !== 'string') {
    throw new Error(`Aucun PDS AT Protocol trouvé pour ${did}`)
  }

  return pds.serviceEndpoint.replace(/\/$/, '')
}

async function resolveTrustedVerifiers() {
  const resolved = new Map()

  for (const identifier of TRUSTED_VERIFIERS) {
    try {
      const did = await resolveIdentifier(identifier)
      const pds = await resolvePdsEndpoint(did)
      resolved.set(identifier, { did, pds })
      console.log(`[verifier] ${identifier} -> ${did} -> ${pds}`)
    } catch (error) {
      console.error(`[verifier] impossible de résoudre ${identifier}:`, error.message)
    }
  }

  if (resolved.size === 0) {
    throw new Error('Aucun certificateur de confiance n’a pu être résolu.')
  }

  verifierDids = resolved
}

function parseRkey(uri) {
  const parts = uri.split('/')
  return parts[parts.length - 1]
}

function isRecentEnough(record) {
  const createdAt = Date.parse(record?.createdAt || '')
  if (!Number.isFinite(createdAt)) return false
  return createdAt >= processStartedAt - STARTUP_GRACE_MS
}

async function fetchVerificationRecords(verifierDid, pds) {
  const pdsAgent = new AtpAgent({ service: pds })
  const response = await pdsAgent.com.atproto.repo.listRecords({
    repo: verifierDid,
    collection: COLLECTION,
    limit: 100,
    reverse: true,
  })

  return response.data.records || []
}

async function buildAnnouncement(verifierDid, record) {
  let verifierLabel = verifierDid

  try {
    const profile = await publicAgent.getProfile({ actor: verifierDid })
    verifierLabel = profile.data.displayName
      ? `${profile.data.displayName} (@${profile.data.handle})`
      : `@${profile.data.handle}`
  } catch {
    // Le DID reste affiché si l'AppView n'est momentanément pas disponible.
  }

  const subjectHandle = record.handle.startsWith('@') ? record.handle : `@${record.handle}`
  const subjectName = record.displayName?.trim() || subjectHandle

  return `✅ Nouvelle certification Kelo Social\n\n${subjectName} (${subjectHandle}) vient d’être certifié par ${verifierLabel}.\n\nCertification délivrée par un certificateur de confiance.`
}

async function publishAnnouncement(verifierDid, verificationRecord) {
  const text = await buildAnnouncement(verifierDid, verificationRecord)
  const response = await bot.post({
    text,
    createdAt: new Date().toISOString(),
    langs: ['fr'],
  })

  console.log(`[post] annonce publiée: ${response.uri}`)
  return response.uri
}

async function scanVerifier(identifier, verifier) {
  const records = await fetchVerificationRecords(verifier.did, verifier.pds)

  // Traitement du plus ancien au plus récent pour conserver l'ordre des annonces.
  for (const item of [...records].reverse()) {
    if (!item?.uri || !item?.value) continue
    if (seenVerificationUris.has(item.uri)) continue

    // Au démarrage, l'historique ancien est mémorisé sans être republié.
    if (!isRecentEnough(item.value)) {
      seenVerificationUris.add(item.uri)
      continue
    }

    const record = item.value
    const validShape =
      record.$type === COLLECTION ||
      (record.subject && record.handle && record.displayName !== undefined && record.createdAt)

    if (!validShape) {
      seenVerificationUris.add(item.uri)
      continue
    }

    try {
      await publishAnnouncement(verifier.did, record)
      seenVerificationUris.add(item.uri)
      console.log(`[certification] ${identifier} a certifié ${record.handle} (${parseRkey(item.uri)})`)
    } catch (error) {
      console.error(`[post] échec pour ${item.uri}:`, error.message)
      // Pas marqué comme vu : nouvel essai au prochain passage.
    }
  }
}

async function poll() {
  try {
    for (const [identifier, verifier] of verifierDids.entries()) {
      await scanVerifier(identifier, verifier)
    }
    lastSuccessfulPollAt = new Date().toISOString()
    lastError = null
  } catch (error) {
    lastError = error.message
    console.error('[poll] erreur:', error)
  }
}

async function start() {
  await bot.login({ identifier: BOT_IDENTIFIER, password: BOT_PASSWORD })
  botDid = bot.session?.did || null
  console.log(`[bot] connecté: ${BOT_IDENTIFIER}${botDid ? ` (${botDid})` : ''}`)

  await resolveTrustedVerifiers()
  await poll()

  setInterval(() => {
    poll().catch((error) => {
      lastError = error.message
      console.error('[poll] erreur non gérée:', error)
    })
  }, POLL_INTERVAL_MS)
}

const app = express()

app.get('/', (_req, res) => {
  res.json({
    service: 'Kelo Verification Bot',
    status: lastError ? 'degraded' : 'ok',
    bot: BOT_IDENTIFIER,
    botDid,
    collection: COLLECTION,
    trustedVerifiers: [...verifierDids.entries()].map(([identifier, verifier]) => ({
      identifier,
      did: verifier.did,
      pds: verifier.pds,
    })),
    pollIntervalMs: POLL_INTERVAL_MS,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.get('/health', (_req, res) => {
  res.status(lastError ? 503 : 200).json({
    ok: !lastError,
    lastSuccessfulPollAt,
    lastError,
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[http] écoute sur le port ${PORT}`)
})

start().catch((error) => {
  lastError = error.message
  console.error('[startup] échec du démarrage:', error)
  process.exitCode = 1
})
