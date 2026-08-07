import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import express from 'express'

import {
  buildCapabilityManifest,
  describeActions,
  isKnownRoutePath,
  listRoutes,
} from './capabilityManifest.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'

function sampleApp() {
  const app = express()
  app.get('/health', (_request, response) => response.end())
  app.post('/execute', (_request, response) => response.end())
  app.get('/jobs', (_request, response) => response.end())
  app.post('/jobs/:jobId/undo', (_request, response) => response.end())
  app.use('/assets', express.static(os.tmpdir()))
  app.use((_request, _response, next) => next())
  return app
}

test('routes are read off the live router, not a hand-kept list', () => {
  const routes = listRoutes(sampleApp())

  assert.deepEqual(
    routes.map((route) => `${route.method} ${route.path}`),
    [
      'POST /execute',
      'GET /health',
      'GET /jobs',
      'POST /jobs/:jobId/undo',
    ],
  )

  const undo = routes.find((route) => route.path === '/jobs/:jobId/undo')
  assert.deepEqual(undo.params, ['jobId'])
  assert.equal(undo.group, 'jobs')
  assert.equal(undo.auth, 'bearer')
  assert.equal(routes.find((route) => route.path === '/health').auth, 'public')
})

test('middleware that matches everything is not mistaken for an endpoint', () => {
  const app = sampleApp()
  // The catch-all layers above would otherwise make every path "known" and
  // put the 404 fix straight back where it started.
  assert.equal(isKnownRoutePath(app, '/jobs'), true)
  assert.equal(isKnownRoutePath(app, '/jobs/local_123/undo'), true)
  assert.equal(isKnownRoutePath(app, '/definitely-not-a-route'), false)
  assert.equal(isKnownRoutePath(app, '/jobs/local_123'), false)
})

test('a file served statically counts as a real path', (t) => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-static-'))
  t.after(() => fs.rmSync(staticDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>')

  const app = sampleApp()
  assert.equal(isKnownRoutePath(app, '/index.html', { staticDir }), true)
  assert.equal(isKnownRoutePath(app, '/missing.html', { staticDir }), false)
})

test('path traversal never answers "this route exists"', (t) => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-escape-'))
  t.after(() => fs.rmSync(staticDir, { recursive: true, force: true }))

  const app = sampleApp()
  assert.equal(
    isKnownRoutePath(app, '/../../../../etc/hosts', { staticDir }),
    false,
  )
  assert.equal(isKnownRoutePath(app, '/%2e%2e/%2e%2e/etc/hosts', { staticDir }), false)
  assert.equal(isKnownRoutePath(app, '/%zz', { staticDir }), false)
})

test('every action type the executor can dispatch is advertised', () => {
  const described = describeActions()
  assert.equal(described.count, SUPPORTED_ACTION_TYPES.length)
  assert.ok(described.count > 40, 'the dispatch table should not be near-empty')

  for (const type of ['run_shell', 'open_app', 'write_file', 'set_volume']) {
    assert.ok(
      described.types.some((entry) => entry.type === type),
      `${type} missing from the manifest`,
    )
  }

  const setVolume = described.types.find((entry) => entry.type === 'set_volume')
  assert.equal(setVolume.reversible, 'conditional')
  assert.equal(setVolume.handsFree, true)

  const shell = described.types.find((entry) => entry.type === 'run_shell')
  assert.equal(shell.reversible, 'never')
  // Freeform shell is not on the hands-free allowlist; classification is
  // reported, never enforced here.
  assert.equal(shell.handsFree, false)
})

test('the dispatch table is parsed from the switch, so it cannot go stale', () => {
  const source = fs.readFileSync(
    new URL('./computerControl.js', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('switch (action.type)')
  const dispatcher = source.slice(
    start,
    source.indexOf('Unsupported action type', start),
  )
  const cases = [
    ...new Set([...dispatcher.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1])),
  ].sort()

  assert.deepEqual([...SUPPORTED_ACTION_TYPES], cases)
})

test('the planner default model in the manifest matches llmPlanner', () => {
  const source = fs.readFileSync(
    new URL('./llmPlanner.js', import.meta.url),
    'utf8',
  )
  const declared = source.match(/process\.env\.LLM_MODEL \|\| '([^']+)'/)?.[1]
  assert.ok(declared, 'llmPlanner no longer declares an LLM_MODEL default')

  const manifest = buildCapabilityManifest(sampleApp())
  const reported = process.env.LLM_MODEL
    ? String(process.env.LLM_MODEL).trim()
    : declared
  assert.equal(manifest.models.planner.model, reported)
})

test('the manifest reports its own documentation rot', () => {
  const app = sampleApp()
  app.get('/brand-new-surface', (_request, response) => response.end())

  const manifest = buildCapabilityManifest(app)
  assert.deepEqual(manifest.http.undocumentedGroups, ['brand-new-surface'])
  assert.equal(manifest.http.routeCount, 5)
  assert.equal(
    manifest.http.groups.find((group) => group.group === 'jobs').module,
    'local-agent/jobTracker.js + undo.js',
  )
})

test('the status contract is published so 401 stops meaning "exists"', () => {
  const manifest = buildCapabilityManifest(sampleApp())
  assert.equal(manifest.http.auth.statusContract['404'], 'no such route on this process')
  assert.match(manifest.http.auth.statusContract['401'], /token missing or wrong/)
  assert.deepEqual(manifest.http.publicPaths, ['/health'])
})

test('capabilities that are not on this process are still named', () => {
  const manifest = buildCapabilityManifest(sampleApp())
  const surfaces = manifest.surfaces.map((surface) => surface.surface)
  assert.deepEqual(surfaces, [
    'cloud-relay',
    'realtime-planner',
    'browser-extension',
    'pendant-firmware',
  ])
})
