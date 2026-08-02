import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = path.join(__dirname, 'InputSourceSelect.swift')
const BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AIPendant')
const BIN_PATH = path.join(BIN_DIR, 'aipendant-inputsource')

export async function listInputSources() {
  const binary = await ensureHelper()
  const { stdout } = await execFileAsync(binary, ['list'], { timeout: 8000 })
  return parseRows(stdout)
}

export async function getCurrentInputSource() {
  const binary = await ensureHelper()
  const { stdout } = await execFileAsync(binary, ['current'], { timeout: 8000 })
  return parseRows(stdout)[0] ?? null
}

export async function selectInputSource(query) {
  const wanted = String(query || '').trim()
  if (!wanted) {
    throw new Error('Input source query is required.')
  }

  const binary = await ensureHelper()
  try {
    const { stdout } = await execFileAsync(binary, ['select', wanted], {
      timeout: 12000,
    })
    const selected = parseRows(stdout)[0]
    if (!selected) {
      throw new Error(`Could not switch input source to “${wanted}”.`)
    }
    return selected
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim()
    throw new Error(detail || `Could not switch input source to “${wanted}”.`)
  }
}

async function ensureHelper() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  const sourceStat = fs.statSync(SOURCE_PATH)
  const needsBuild =
    !fs.existsSync(BIN_PATH) ||
    fs.statSync(BIN_PATH).mtimeMs < sourceStat.mtimeMs

  if (needsBuild) {
    await execFileAsync(
      'swiftc',
      ['-O', '-o', BIN_PATH, SOURCE_PATH],
      { timeout: 60000 },
    )
    fs.chmodSync(BIN_PATH, 0o755)
  }

  return BIN_PATH
}

function parseRows(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, flag] = line.split('\t')
      return {
        id,
        name,
        enabledNow: flag === 'enabled',
      }
    })
}
