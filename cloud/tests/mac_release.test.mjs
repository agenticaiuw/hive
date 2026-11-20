// A Mac release (cloud/release.mjs mac) is versioned by the sources it's built from and holds what a
// build makes: the tools the Makefile builds, read from the Makefile itself, and never build output,
// installs or Rust targets among the sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hiveBins, MAC_SOURCES, sourceFiles } from '../release.mjs'
import { bundleVersion } from '../vm-agent/version.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

test("the Rust tools are the Makefile's own list, continued lines included", () => {
  assert.deepEqual(hiveBins('X := 1\nHIVE_BINS := hive-agent \\\n\thive-tasks hive-cloud\nY := 2\n'), ['hive-agent', 'hive-tasks', 'hive-cloud'])
  assert.throws(() => hiveBins('X := 1\n'), /no HIVE_BINS/)
  const bins = hiveBins(fs.readFileSync(path.join(REPO, 'desktop/app/Makefile'), 'utf8'))
  assert.ok(bins.includes('hive-agent') && bins.includes('hive-cloud'), 'the agent and its cloud tool are in every release')
})

test('the version is the sources: a change to one changes it, build output and installs never do', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-release-'))
  const write = (rel, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text, { mode })
  }
  write('desktop/app/crates/hive/hive-app/src/app.rs', 'fn main() {}')
  write('desktop/app/Makefile', 'HIVE_BINS := hive-agent\n')
  write('desktop/app/tools/ocr.swift', 'print(1)', 0o755)
  write('dashboard/src/app.js', 'export {}')
  const before = bundleVersion(sourceFiles(root, MAC_SOURCES))
  write('desktop/app/crates/hive/target/release/hive-agent', 'binary')
  write('dashboard/node_modules/x/index.js', 'x')
  write('dashboard/build/index.html', '<p>')
  assert.equal(bundleVersion(sourceFiles(root, MAC_SOURCES)), before)
  const files = sourceFiles(root, MAC_SOURCES)
  assert.deepEqual(files.map((f) => [f.path, f.mode]), [
    ['desktop/app/crates/hive/hive-app/src/app.rs', 0o644],
    ['desktop/app/tools/ocr.swift', 0o755],
    ['desktop/app/Makefile', 0o644],
    ['dashboard/src/app.js', 0o644],
  ])
  write('dashboard/src/app.js', 'export const changed = 1')
  assert.notEqual(bundleVersion(sourceFiles(root, MAC_SOURCES)), before)
  fs.rmSync(root, { recursive: true, force: true })
})
