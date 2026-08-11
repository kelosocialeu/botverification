import 'dotenv/config'
import express from 'express'
import { AtpAgent, RichText } from '@atproto/api'

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

async function resolveTrustedVerifiers() {
  const resolved = new Map()

  for (const identifier of TRUSTED_VERIFIERS) {
    try {
      const did = await resolveIdentifier(identifier)
      resolved.set(identifier, did)
      console.log(`[verifier] ${identifier} -> ${did}`)
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

async function fetchVerificationRecords(verifierDid) {
  const response = await publicAgent.com.atproto.repo.listRecords({
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
    // Le DID reste utilisable si le profil n’est momentanément pas récupérable.
  }

  const subjectHandle = record.handle.startsWith('@') ? record.handle : `@${record.handle}`
  const subjectName = record.displayName?.trim() || subjectHandle

  return `✅ Nouvelle certification Kelo Social\n\n${subjectName} (${subjectHandle}) vient d’être certifié par ${verifierLabel}.\n\nCertification délivrée par un certificateur de confiance.`
}

async function publishAnnouncement(verifierDid, verificationRecord) {
  const text = await buildAnnouncement(verifierDid, verificationRecord)
  const richText = new RichText({ text })
  await richText.detectFacets(bot)

  const response = await bot.post({
    text: richText.text,
    facets: richText.facets,
    createdAt: new Date().toISOString(),
    langs: ['fr'],
  })

  console.log(`[post] annonce publiée: ${response.uri}`)
  return response.uri
}

async function scanVerifier(identifier, verifierDid) {
  const records = await fetchVerificationRecords(verifierDid)

  // On traite du plus ancien au plus récent pour conserver l’ordre des annonces.
  for (const item of [...records].reverse()) {
    if (!item?.uri || !item?.value) continue
    if (seenVerificationUris.has(item.uri)) continue

    // Au démarrage, on mémorise l’historique ancien sans le republier.
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
      await publishAnnouncement(verifierDid, record)
      seenVerificationUris.add(item.uri)
      console.log(`[certification] ${identifier} a certifié ${record.handle} (${parseRkey(item.uri)})`)
    } catch (error) {
      console.error(`[post] échec pour ${item.uri}:`, error.message)
      // On ne marque pas comme vu afin de réessayer au prochain passage.
    }
  }
}

async function poll() {
  try {
    for (const [identifier, did] of verifierDids.entries()) {
      await scanVerifier(identifier, did)
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
    trustedVerifiers: [...verifierDids.entries()].map(([identifier, did]) => ({ identifier, did })),
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

app.listen(PORT, () => {
  console.log(`[http] écoute sur le port ${PORT}`)
})

start().catch((error) => {
  lastError = error.message
  console.error('[startup] échec du démarrage:', error)
  process.exitCode = 1
})
