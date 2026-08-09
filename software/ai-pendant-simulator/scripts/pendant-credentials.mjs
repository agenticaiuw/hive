#!/usr/bin/env node
/*
 * Commission one device onto the relay with its own scoped, revocable token.
 *
 * The scoped credential system was fully built and used by nobody: POST
 * /v1/devices/pair could mint a `pdt_<id>.<secret>` and store only its
 * SHA-256, per-role scope sets existed, every route was gated — and every
 * client (pendant firmware, Mac bridge) authenticated with the shared admin
 * RELAY_API_KEY instead, whose '*' scope makes the whole table a no-op. The
 * missing piece was never the mechanism; it was a human-runnable way to mint,
 * inventory and kill a credential. This is that piece.
 *
 *   node scripts/pendant-credentials.mjs pair --device-id home-macbook-bridge \
 *        --role mac_bridge --name "Home MacBook Bridge"
 *   node scripts/pendant-credentials.mjs list
 *   node scripts/pendant-credentials.mjs revoke --token-id <tokenId>
 *
 * Run it ONCE per device. `pair` prints the token exactly once and the relay
 * cannot ever print it again — it kept a hash, not the secret. Losing it costs
 * a re-pair (cheap) and a revoke of the stray row (also cheap); that asymmetry
 * is the entire point of moving off a key that could never be re-issued
 * without taking every other node down with it.
 *
 * Credentials used by this script, read from the repo-root .env, never echoed:
 *   PAIRING_CODE   — proves the human at the keyboard may commission a device
 *                    (pair only; the route is pre-auth by design so a device
 *                    with no credential yet can obtain its first one)
 *   RELAY_API_KEY  — admin, for list/revoke under /v1/ops/*. This stays an
 *                    owner-operated key on the owner's machine, which is the
 *                    one place it is defensible.
 */
import '../../load-pendant-env.mjs'

/* Mirrors SUPPORTED_DEVICE_TYPES in cloud-relay/deviceAuth.js. Duplicated
 * rather than imported: this script runs against a REMOTE relay and must not
 * imply that the roles this checkout knows about are the ones that relay
 * accepts. The relay rejects an unknown role on its own; this list only makes
 * the usage line useful. */
const ROLES = ['mobile', 'mac_bridge', 'nrf_pendant', 'browser_node']

const USAGE = `Usage:
  pendant-credentials.mjs pair --device-id <id> --role <${ROLES.join('|')}> [--name <label>]
  pendant-credentials.mjs list [--device-id <id>] [--json]
  pendant-credentials.mjs revoke --token-id <tokenId>

Options:
  --relay-url <url>   Override RELAY_URL from .env.
  --help              This text.

Environment (from the repo-root .env; never printed):
  RELAY_URL, PAIRING_CODE (pair), RELAY_API_KEY (list/revoke).`

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'json' || key === 'help') {
      args[key] = true
      continue
    }
    index += 1
    args[key] = argv[index]
  }
  return args
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function relayUrl(args) {
  const url = String(args['relay-url'] || process.env.RELAY_URL || '').trim()
  if (!url) fail('RELAY_URL is not set (repo-root .env) and --relay-url was not given.')
  return url.replace(/\/$/, '')
}

async function readJson(response) {
  const raw = await response.text()
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, error: `${response.status}: ${raw.slice(0, 200)}` }
  }
}

async function pair(args) {
  const deviceId = String(args['device-id'] || '').trim()
  const role = String(args.role || '').trim()
  const name = String(args.name || '').trim() || deviceId
  const pairingCode = String(process.env.PAIRING_CODE || '').trim()

  if (!deviceId) fail('--device-id is required.')
  if (!ROLES.includes(role)) fail(`--role must be one of: ${ROLES.join(', ')}.`)
  if (!pairingCode) {
    fail('PAIRING_CODE is not set in the repo-root .env; the relay refuses pairing without it.')
  }

  const response = await fetch(`${relayUrl(args)}/v1/devices/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, deviceType: role, name, pairingCode }),
  })
  const payload = await readJson(response)
  if (!response.ok || !payload.ok) {
    fail(payload.error || `pairing failed (${response.status})`)
  }

  const credential = payload.credential
  /*
   * stdout is the token, alone, so it can be piped straight into a file or a
   * secret manager without a human reading it off a screen. Everything a human
   * needs goes to stderr, so `> token` captures exactly the secret and nothing
   * else. Nothing here logs the token a second time.
   */
  console.error(`Paired ${deviceId} as ${credential.role}.`)
  console.error(`  tokenId : ${credential.tokenId}`)
  console.error(`  scopes  : ${credential.scopes.join(', ')}`)
  console.error(`  created : ${credential.createdAt}`)
  console.error('')
  console.error('The token is printed once on stdout and is unrecoverable afterwards.')
  console.error('Store it, then verify with: pendant-credentials.mjs list')
  console.log(credential.token)
}

async function list(args) {
  const adminKey = String(process.env.RELAY_API_KEY || '').trim()
  if (!adminKey) fail('RELAY_API_KEY is required to list credentials.')

  const deviceId = String(args['device-id'] || '').trim()
  const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
  const response = await fetch(`${relayUrl(args)}/v1/ops/credentials${query}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  })
  const payload = await readJson(response)
  if (!response.ok || !payload.ok) {
    fail(payload.error || `list failed (${response.status})`)
  }

  if (args.json) {
    console.log(JSON.stringify(payload.credentials, null, 2))
    return
  }

  if (!payload.credentials.length) {
    console.log('No device credentials. Every client is still on the admin key.')
    return
  }

  const rows = payload.credentials.map((credential) => ({
    tokenId: credential.tokenId,
    device: credential.deviceId,
    role: credential.role,
    state: credential.revokedAt ? 'REVOKED' : 'active',
    lastUsed: credential.lastUsedAt || 'never',
    created: credential.createdAt,
  }))
  console.table(rows)
}

async function revoke(args) {
  const adminKey = String(process.env.RELAY_API_KEY || '').trim()
  if (!adminKey) fail('RELAY_API_KEY is required to revoke a credential.')

  const tokenId = String(args['token-id'] || '').trim()
  if (!tokenId) fail('--token-id is required (see: pendant-credentials.mjs list).')

  const response = await fetch(
    `${relayUrl(args)}/v1/ops/credentials/${encodeURIComponent(tokenId)}/revoke`,
    { method: 'POST', headers: { Authorization: `Bearer ${adminKey}` } },
  )
  const payload = await readJson(response)
  if (!response.ok || !payload.ok) {
    fail(payload.error || `revoke failed (${response.status})`)
  }

  const credential = payload.credential
  console.log(
    payload.alreadyRevoked
      ? `${tokenId} was already revoked at ${credential.revokedAt}.`
      : `Revoked ${tokenId} (${credential.deviceId}, ${credential.role}) at ${credential.revokedAt}.`,
  )
  console.log(
    'The next request carrying it is refused with invalid_or_revoked_device_token.',
  )
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]

if (args.help || !command) {
  console.log(USAGE)
  /* Asking for help succeeded; being run with nothing did not. */
  process.exit(args.help ? 0 : 1)
}

const commands = { pair, list, revoke }
if (!commands[command]) {
  console.error(`error: unknown command "${command}".\n`)
  console.error(USAGE)
  process.exit(1)
}

await commands[command](args).catch((error) => {
  fail(error?.message || String(error))
})
