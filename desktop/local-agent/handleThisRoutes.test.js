import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const EVIDENCE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-handle-this-routes-'))
process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(EVIDENCE_DIRECTORY, 'capsules.json')
/* A closed port, so these routes never reach the developer's running agent and
 * start reading their real Safari tabs. See handleThisPanel.test.js. */
process.env.LOCAL_AGENT_URL = 'http://127.0.0.1:1'

const { registerHandleThisRoutes } = await import('./handleThisRoutes.js')

test.after(() => fs.rmSync(EVIDENCE_DIRECTORY, { force: true, recursive: true }))

/*
 * An express stand-in, matching formPreview.test.js. Routes are looked up by
 * their pattern string, so the registration order the real express relies on is
 * visible here rather than hidden behind a matcher.
 */
function fakeApp() {
  const routes = new Map()
  const order = []
  const register = (method) => (route, handler) => {
    routes.set(`${method} ${route}`, handler)
    order.push(`${method} ${route}`)
  }

  return {
    get: register('GET'),
    post: register('POST'),
    delete: register('DELETE'),
    order,
    async call(method, route, { params = {}, query = {}, body = {} } = {}) {
      const handler = routes.get(`${method} ${route}`)
      if (!handler) throw new Error(`No route registered for ${method} ${route}`)

      let statusCode = 200
      let payload = null
      const response = {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      }

      await handler({ params, query, body }, response)
      return { statusCode, payload }
    },
  }
}

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-handle-this-routes-store-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return path.join(directory, 'handle-this.json')
}

test('registering refuses anything that is not an express-style app', () => {
  assert.throws(() => registerHandleThisRoutes({}), /Express-style app/)
})

test('the mounted routes are the shape server.js already calls', (t) => {
  const app = fakeApp()
  const mounted = registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  assert.ok(mounted.mounted.includes('POST /handle-this'))
  /* No approve route and no send route: approval lives in formPreview behind a
   * confirm code, and a second door onto it is a second way to get it wrong. */
  assert.ok(!mounted.mounted.some((route) => /approve|send|submit/i.test(route)))
})

test('the collection route is registered before the one that takes an id', (t) => {
  /* Express matches in registration order, so the other way round would read
   * "/handle-this/investigations" as an investigation called "investigations". */
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  assert.ok(
    app.order.indexOf('GET /handle-this/investigations') <
      app.order.indexOf('GET /handle-this/investigations/:investigationId'),
  )
})

test('the lens list says every lens is read-only', async (t) => {
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  const { payload } = await app.call('GET', '/handle-this/lenses')
  assert.ok(payload.lenses.length >= 3)
  assert.match(payload.note, /No lens can click, type, or submit/)
})

test('a bad pattern is a 400 with the pattern in it, not a throw mid-browse', async (t) => {
  /* Compiled at the door on purpose: the alternative is discovering it from
   * inside a read that has already opened a tab. */
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  const { statusCode, payload } = await app.call('POST', '/handle-this/investigate', {
    body: { questions: [{ key: 'order.total', patterns: ['total ([0-9'] }] },
  })

  assert.equal(statusCode, 400)
  assert.match(payload.error, /invalid pattern/)
})

test('an investigation with no browser connected answers rather than queueing', async (t) => {
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  const { statusCode, payload } = await app.call('POST', '/handle-this/investigate', {
    body: {
      ask: 'what does this say',
      anchorUrl: 'https://shop.example.com/orders/1',
      questions: [{ key: 'order.total', labels: ['Order total'] }],
    },
  })

  assert.equal(statusCode, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.submitted, false)
  assert.equal(payload.investigation.status, 'recalled')
  assert.deepEqual(payload.disagreements, [])
})

test('a stored investigation can be read back, with its report and what happens next', async (t) => {
  const filePath = withTemporaryStore(t)
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath })

  const created = await app.call('POST', '/handle-this', {
    body: {
      ask: 'handle this',
      anchorUrl: 'https://shop.example.com/orders/1',
      questions: [{ key: 'order.total', labels: ['Order total'] }],
    },
  })

  assert.equal(created.statusCode, 201)
  assert.equal(created.payload.submitted, false)
  assert.match(created.payload.note, /Nothing was submitted or sent/)

  const id = created.payload.investigation.investigationId
  const fetched = await app.call('GET', '/handle-this/investigations/:investigationId', {
    params: { investigationId: id },
  })

  assert.equal(fetched.payload.ok, true)
  assert.equal(fetched.payload.investigation.investigationId, id)
  assert.equal(fetched.payload.willHappen.submitted, false)
  assert.equal(fetched.payload.readOnly, true)

  const listed = await app.call('GET', '/handle-this/investigations', { query: { limit: '5' } })
  assert.equal(listed.payload.investigations.length, 1)
})

test('an unknown investigation is a 404, not an empty success', async (t) => {
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  const { statusCode, payload } = await app.call(
    'GET',
    '/handle-this/investigations/:investigationId',
    { params: { investigationId: 'hti_nope' } },
  )

  assert.equal(statusCode, 404)
  assert.equal(payload.ok, false)
})

test('too many questions is refused before any page is read', async (t) => {
  const app = fakeApp()
  registerHandleThisRoutes(app, { filePath: withTemporaryStore(t) })

  const { statusCode, payload } = await app.call('POST', '/handle-this/investigate', {
    body: {
      questions: Array.from({ length: 20 }, (_, index) => ({
        key: `q${index}`,
        labels: ['Total'],
      })),
    },
  })

  assert.equal(statusCode, 400)
  assert.match(payload.error, /At most 12 questions/)
})
