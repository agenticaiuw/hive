import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parse } from 'dotenv'

const projectRoot = resolve(import.meta.dirname, '..')
const productionRelayUrl =
  process.env.IOS_RELAY_URL ||
  'https://ai-pendant-relay.your-subdomain.workers.dev'

const build = spawnSync(
  process.execPath,
  [join(projectRoot, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'ios'],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      VITE_RELAY_URL: productionRelayUrl,
      VITE_RELAY_API_KEY: '',
      VITE_PAIRING_CODE: '',
      VITE_AGENT_TOKEN: '',
    },
    stdio: 'inherit',
  },
)

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

verifyNoLocalSecrets()
console.log(`iOS web bundle targets ${productionRelayUrl} with no embedded admin credential.`)

function verifyNoLocalSecrets() {
  const envPath = join(projectRoot, '.env')
  let localEnv = {}

  try {
    localEnv = parse(readFileSync(envPath))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  const sensitiveValues = Object.entries(localEnv)
    .filter(([key, value]) =>
      /(TOKEN|KEY|SECRET|PASSWORD|PAIRING_CODE)/i.test(key) &&
      String(value).length >= 8,
    )
    .map(([, value]) => String(value))

  const bundleText = collectTextFiles(join(projectRoot, 'dist'))
  if (sensitiveValues.some((value) => bundleText.includes(value))) {
    throw new Error(
      'Blocked iOS build because a local credential was embedded in dist/.',
    )
  }
}

function collectTextFiles(directory) {
  let output = ''

  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const metadata = statSync(path)
    if (metadata.isDirectory()) {
      output += collectTextFiles(path)
    } else if (/\.(?:css|html|js|json|map|svg|txt)$/i.test(name)) {
      output += readFileSync(path, 'utf8')
    }
  }

  return output
}
