import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/*
 * A route module that nobody mounts.
 *
 * Six of these turned up in one day. Each time the module was finished, its own
 * tests passed, and the single line that made it reachable did not exist —
 * `registerApprovalRoutes` was called only from its own test while
 * shared/approvalHandoff.js already declared it as the implementation of the
 * approval contract; `registerContextGraphRetentionRoutes` returned 404 live;
 * `registerBriefingShelfRoutes` left the record of silently-deleted briefings
 * readable only by opening a JSON file by hand.
 *
 * Nothing catches this. A unit test exercises the handler by calling the
 * register function itself, so it passes whether or not a server ever does.
 * From outside, a capability whose last link is missing is indistinguishable
 * from one that was never built — which is exactly how nine proposals came to
 * be re-asked for work that had already shipped.
 *
 * This walks the source rather than importing anything: importing every module
 * to inspect it would run their module-scope side effects, and several open
 * stores or read the workspace at import time.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* The servers are the only legitimate mount points, plus a module that composes
 * another's routes into its own registration. */
const SEARCHED = ['local-agent', 'cloud-relay', 'shared', 'browser-extension/src']

const sourceFiles = () => {
  const out = []
  for (const dir of SEARCHED) {
    const full = path.join(ROOT, dir)
    if (!fs.existsSync(full)) continue
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue
      out.push(path.join(dir, name))
    }
  }
  return out
}

/*
 * Named `register…Routes` AND taking `app` first. Both halves matter: the suffix
 * alone would sweep in registerCapabilities and registerGrantedTools, which are
 * registries rather than routers and have no server to be mounted on.
 */
const ROUTE_REGISTRAR = /^export function (register[A-Za-z0-9]*Routes)\s*\(\s*app\b/gm

/*
 * Comments are stripped before searching for callers, and that is load-bearing
 * rather than tidy. Mutation-tested: commenting out `registerBriefingShelfRoutes(app)`
 * left the text on the line, the caller regex matched it, and this test PASSED
 * on a module that was no longer mounted — a guard against unreachable routes
 * that was itself fooled by a `//`. Comments also legitimately name these calls,
 * since the note above the removed inline /watches block cites
 * registerPageWatchRoutes(app) by name.
 */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

test('every route registration function is called by something that is not its own test', () => {
  const files = sourceFiles()
  const bodies = new Map(
    files.map((rel) => [rel, withoutComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))]),
  )

  const declared = []
  for (const [rel, body] of bodies) {
    for (const match of body.matchAll(ROUTE_REGISTRAR)) {
      declared.push({ name: match[1], file: rel })
    }
  }

  assert.ok(
    declared.length >= 20,
    `expected to find the route registrars; found ${declared.length}. The pattern probably stopped matching, which would make this test pass by seeing nothing.`,
  )

  const unmounted = declared.filter(({ name, file }) => {
    const called = new RegExp(`\\b${name}\\s*\\(\\s*app\\b`)
    for (const [rel, body] of bodies) {
      if (rel === file) continue // its own definition
      if (called.test(body)) return false
    }
    return true
  })

  assert.deepEqual(
    unmounted.map(({ name, file }) => `${name} (${file})`),
    [],
    'these define routes that no server mounts, so the routes do not exist at runtime',
  )
})

test('no route is shadowed by one registered before it', () => {
  /*
   * Express keeps the FIRST layer that matches, so two shapes lose silently:
   *
   *   exact duplicate  — server.js carried 72 lines of inline /watches handlers
   *                      while pageWatchRoutes.js registered the same paths 600
   *                      lines earlier. The inline copy had never run; it only
   *                      added six shadow layers, which surfaced in the
   *                      published manifest as two ways to do one thing.
   *   parameter eats a literal — GET /research/briefings/:id registered before a
   *                      literal /research/briefings/shelf would match "shelf"
   *                      as an id and answer 404 for a thing that exists.
   *
   * Same-family coexistence is NOT the defect, and an earlier draft of this
   * test flagged it and produced twenty-one false positives: /briefing and
   * /briefing/triage are distinct literals and both work. Only the two shapes
   * above are checked.
   */
  const serverPath = path.join(ROOT, 'local-agent', 'server.js')
  const lines = fs.readFileSync(serverPath, 'utf8').split('\n')

  const baseOf = (text) => {
    const m =
      text.match(/basePath\s*=\s*['"`]([^'"`]*)['"`]/) ??
      text.match(/basePath\s*\?\?\s*['"`]([^'"`]*)['"`]/)
    return m ? m[1] : ''
  }

  /* Registration order: a literal in server.js is ordered by its own line; a
   * module's routes all take the line of the register call that mounts them. */
  const routes = []
  lines.forEach((line, i) => {
    /* Comments mention these calls — the note above the removed inline /watches
     * block names registerPageWatchRoutes(app) explicitly — and counting a
     * mention as a mount made the module appear to shadow itself. */
    const code = line.trim()
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return

    const own = line.match(/\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/)
    if (own) routes.push({ order: i, method: own[1], path: own[2], from: 'server.js' })

    const mount = line.match(/\b(register[A-Za-z0-9]*Routes)\s*\(\s*app\b/)
    if (!mount) return
    for (const rel of sourceFiles()) {
      if (rel === 'local-agent/server.js') continue
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      if (!new RegExp('^export function ' + mount[1] + '\\b', 'm').test(text)) continue
      const base = baseOf(text)
      for (const m of text.matchAll(
        /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(?:route\()?\s*[`'"]([^`'"]+)/g,
      )) {
        const raw = m[2]
        const full = raw.startsWith('${') ? base + raw.replace(/^\$\{[^}]*\}/, '') : raw
        routes.push({ order: i, method: m[1], path: full, from: rel })
      }
    }
  })

  const problems = []
  for (let a = 0; a < routes.length; a += 1) {
    for (let b = a + 1; b < routes.length; b += 1) {
      const first = routes[a]
      const later = routes[b]
      if (first.method !== later.method) continue
      if (first.from === later.from && first.order === later.order) continue

      if (first.path === later.path) {
        problems.push(first.method.toUpperCase() + ' ' + first.path + ': ' + first.from + ' shadows ' + later.from)
        continue
      }
      if (!first.path.includes(':') || later.path.includes(':')) continue
      const asRegex = new RegExp('^' + first.path.replace(/:[A-Za-z0-9_]+/g, '[^/]+') + '$')
      if (asRegex.test(later.path)) {
        problems.push(
          first.method.toUpperCase() + ' ' + first.path + ' (' + first.from + ') swallows ' + later.path + ' (' + later.from + ')',
        )
      }
    }
  }

  assert.deepEqual([...new Set(problems)], [], 'the first matching layer wins, silently')
})
