// The VM worker: one signed-in browser, a post ledger, a control socket and an on-request viewer.
//
// Control is a Unix socket only the owning user can open; nothing listens on a public address.
// The viewer (a live picture of the browser plus mouse and keyboard forwarding) exists so the
// owner can sign in and watch. It binds to loopback, needs a one-time link, and is reached
// through an SSH tunnel. Forwarded input is never logged or stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { BrowserSession } from './browser.mjs';
import { PostError, PostStore } from './posts.mjs';
import { arrive, deliver } from './poster.mjs';
import { recipeFor, validatePost, RECIPES, ownedLink } from './sites.mjs';

const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');
const UPLOAD_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov', '.pdf', '.txt']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const readBody = (request, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > limit) { reject(new HttpError(413, 'too_large', 'request body too large')); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});

export function createAgent({
  stateDir, executable, headless = false, extraRecipes = {}, timeouts = {},
  approvalTtlMs = 10 * 60_000, viewerPort = 38917, viewerIdleMs = 20 * 60_000, log = () => {},
}) {
  for (const dir of [stateDir, join(stateDir, 'uploads'), join(stateDir, 'evidence')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  }
  const store = new PostStore(join(stateDir, 'posts.sqlite'));
  const logins = {};
  let browser = null; let browserError = null; let browserSince = null;
  let queue = Promise.resolve();
  let viewer = null;

  // One browser, one tab: every operation that touches the page waits its turn.
  const exclusive = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };

  async function page() {
    if (browser?.alive) return browser;
    browser = null;
    try {
      browser = await BrowserSession.launch({ executable, headless, profileDir: join(stateDir, 'profile') });
      browserError = null; browserSince = Date.now();
      log('browser started');
      return browser;
    } catch (error) { browserError = { message: error.message, at: Date.now() }; throw new HttpError(503, 'browser_unavailable', error.message); }
  }

  const recipe = platform => { try { return recipeFor(platform, extraRecipes); } catch (error) { throw new HttpError(400, 'bad_platform', error.message); } };
  const noteLogin = (platform, state) => { logins[platform] = { state, checkedAt: Date.now() }; return logins[platform]; };
  const uploadPath = id => {
    if (!/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/.test(id)) throw new HttpError(400, 'bad_attachment', 'unknown attachment');
    const path = join(stateDir, 'uploads', id);
    if (!existsSync(path)) throw new HttpError(400, 'bad_attachment', 'attachment was not uploaded');
    return path;
  };

  const actions = {
    'GET /status': async () => ({
      now: Date.now(),
      browser: browser?.alive ? { state: 'running', since: browserSince } : { state: browserError ? 'failed' : 'not_started', error: browserError },
      logins, // each entry carries the time it was observed; nothing here is re-checked on read
      viewer: viewer ? { open: true, port: viewer.port, expiresAt: viewer.lastUsed + viewerIdleMs } : { open: false },
      recent: store.list(5).map(({ id, platform, status, updatedAt }) => ({ id, platform, status, updatedAt })),
    }),

    'POST /check': ({ platform }) => exclusive(async () => {
      const site = recipe(platform);
      const arrival = await arrive(await page(), site, site.homeUrl, timeouts.arriveMs);
      return noteLogin(platform, arrival.state === 'ready' ? 'signed_in' : arrival.state === 'needs_login' ? 'needs_login' : 'unknown');
    }),

    'POST /draft': async ({ id, platform, destination, text, attachments = [], resolveLabel = true }) => {
      const site = recipe(platform);
      if (!Array.isArray(attachments)) throw new HttpError(400, 'bad_request', 'attachments must be a list');
      attachments.forEach(uploadPath);
      let checked;
      try { checked = validatePost(site, { destination, text, attachments }); } catch (error) { throw new HttpError(400, 'bad_post', error.message); }
      const post = store.draft({ id, platform, destination: checked.target.url, text: checked.text, attachments });
      let loginState = null; let labelError = null;
      if (resolveLabel && post.status === 'drafted' && !post.label) {
        await exclusive(async () => {
          const tab = await page();
          const arrival = await arrive(tab, site, checked.target.url, timeouts.arriveMs);
          loginState = noteLogin(platform, arrival.state === 'ready' ? 'signed_in' : arrival.state === 'needs_login' ? 'needs_login' : 'unknown').state;
          if (arrival.state === 'ready') store.setLabel(post.id, await tab.call(site.page.label));
        }).catch(error => { labelError = error.message; });
      }
      return { ...store.get(post.id), loginState, labelError };
    },

    'POST /approve': async ({ id, digest }) => store.approve(id, digest),
    'POST /cancel': async ({ id }) => store.cancel(id),

    'POST /send': ({ id }) => exclusive(async () => {
      const queued = store.get(id);
      if (!queued) throw new PostError('not_found', 'no such post');
      const site = recipe(queued.platform);
      const tab = await page(); // a browser that cannot start must not consume the approval
      const post = store.begin(id, { approvalTtlMs });
      let outcome;
      try {
        outcome = await deliver(tab, site, post, {
          resolveUpload: uploadPath, timeouts,
          saveEvidence: async (name, jpeg) => {
            if (!jpeg) return null;
            const path = join(stateDir, 'evidence', `${post.id}-${name}.jpg`);
            writeFileSync(path, jpeg, { mode: 0o600 });
            return path;
          },
        });
      } catch (error) {
        // An error thrown mid-delivery cannot say whether the submit happened.
        outcome = { status: 'unknown', detail: { reason: 'delivery_error', message: error.message, submitted: null } };
      }
      if (outcome.detail?.reason === 'needs_login') noteLogin(post.platform, 'needs_login');
      else if (outcome.status === 'sent') noteLogin(post.platform, 'signed_in');
      log(`post ${post.id} -> ${outcome.status}`);
      return store.finish(id, outcome.status, outcome.detail);
    }),

    'GET /post': async ({ id }) => { const post = store.get(id); if (!post) throw new PostError('not_found', 'no such post'); return post; },
    'GET /posts': async ({ limit }) => ({ posts: store.list(Number(limit) || 20) }),

    'GET /screenshot': () => exclusive(async () => {
      const tab = await page();
      return { at: Date.now(), url: await tab.url(), jpegBase64: (await tab.screenshot()).toString('base64') };
    }),

    // Read-only help for finding a destination link in the owner's own account.
    'POST /discover': ({ platform, server }) => exclusive(async () => {
      const site = recipe(platform);
      if (!site.page.servers) throw new HttpError(400, 'unsupported', `${platform} has nothing to discover`);
      if (server !== undefined && !/^\d{15,22}$/.test(String(server))) throw new HttpError(400, 'bad_request', 'server must be an id');
      const tab = await page();
      const arrival = await arrive(tab, site, server ? `https://discord.com/channels/${server}` : site.homeUrl, timeouts.arriveMs);
      if (arrival.state === 'needs_login') { noteLogin(platform, 'needs_login'); throw new HttpError(409, 'needs_login', 'sign in first'); }
      const list = server ? site.page.channels : site.page.servers;
      const found = await tab.waitFor(list, [], { timeoutMs: 15_000 });
      return server ? { server, channels: found ?? [] } : { servers: found ?? [] };
    }),

    'POST /view/open': async ({ site }) => {
      if (site !== undefined) recipe(site);
      await exclusive(page);
      if (!viewer) viewer = await openViewer();
      viewer.token = randomBytes(24).toString('base64url');
      viewer.lastUsed = Date.now();
      if (site) await exclusive(async () => (await page()).goto(recipe(site).loginUrl).catch(() => null));
      return { port: viewer.port, token: viewer.token, expiresAt: viewer.lastUsed + viewerIdleMs };
    },
    'POST /view/close': async () => { await closeViewer(); return { open: false }; },
  };

  // ---- viewer -------------------------------------------------------------------------------

  async function openViewer() {
    const state = { port: null, token: null, sessions: new Set(), clients: new Set(), lastUsed: Date.now(), casting: false, size: { width: 1280, height: 800 }, off: null, timer: null };
    const authed = request => {
      const cookie = /(?:^|;\s*)hv=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
      return !!cookie && state.sessions.has(cookie);
    };
    const localOrigin = request => {
      const origin = request.headers.origin;
      if (!origin) return true;
      try { return ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname); } catch { return false; }
    };
    const pushFrame = (jpegBase64, size) => {
      if (size) state.size = size;
      const event = `data: ${JSON.stringify({ d: jpegBase64, w: state.size.width, h: state.size.height })}\n\n`;
      for (const client of state.clients) client.write(event);
    };
    const startCast = async () => {
      const tab = await page();
      if (!state.off) {
        state.off = tab.onEvent((method, params) => {
          if (method !== 'Page.screencastFrame') return;
          tab.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
          pushFrame(params.data, { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight });
        });
      }
      if (!state.casting) { state.casting = true; await tab.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1200 }); }
      pushFrame((await tab.screenshot({ quality: 60 })).toString('base64'), await tab.viewport());
    };
    const stopCast = async () => {
      state.casting = false;
      if (browser?.alive) await browser.send('Page.stopScreencast').catch(() => {});
    };
    const forward = async event => {
      const tab = await page();
      const { width, height } = state.size;
      const at = { x: Math.round(Math.min(1, Math.max(0, Number(event.x) || 0)) * width), y: Math.round(Math.min(1, Math.max(0, Number(event.y) || 0)) * height) };
      const modifiers = Number(event.mod) & 15;
      if (event.t === 'm' && ['mouseMoved', 'mousePressed', 'mouseReleased'].includes(event.k)) {
        await tab.mouse(event.k, at.x, at.y, { modifiers, ...(event.k === 'mouseMoved' ? { buttons: event.down ? 1 : 0 } : { button: 'left', clickCount: Math.min(3, Number(event.c) || 1) }) });
      } else if (event.t === 'w') {
        await tab.mouse('mouseWheel', at.x, at.y, { deltaX: Number(event.dx) || 0, deltaY: Number(event.dy) || 0, modifiers });
      } else if (event.t === 'k' && ['keyDown', 'keyUp'].includes(event.k)) {
        const text = event.k === 'keyDown' && typeof event.text === 'string' && event.text.length <= 4 ? event.text : undefined;
        await tab.send('Input.dispatchKeyEvent', {
          type: event.k === 'keyUp' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', modifiers,
          key: String(event.key ?? '').slice(0, 32), code: String(event.code ?? '').slice(0, 32),
          windowsVirtualKeyCode: Number(event.kc) || 0, ...(text ? { text } : {}),
          ...(event.k === 'keyDown' && event.command === 'selectAll' ? { commands: ['selectAll'] } : {}),
        });
      } else if (event.t === 'text' && typeof event.text === 'string' && event.text.length <= 4096) {
        await tab.insertText(event.text);
      }
    };

    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://viewer.invalid');
      const send = (status, body, headers = {}) => { response.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); response.end(body); };
      try {
        if (request.method === 'GET' && url.pathname === '/auth') {
          const given = Buffer.from(url.searchParams.get('t') ?? ''); const expected = Buffer.from(state.token ?? '');
          if (!state.token || given.length !== expected.length || !timingSafeEqual(given, expected)) return send(403, 'This link has expired. Run the sign-in command again.');
          state.token = null; // one use
          const session = randomBytes(24).toString('base64url');
          state.sessions.add(session); state.lastUsed = Date.now();
          return send(302, '', { location: '/', 'set-cookie': `hv=${session}; HttpOnly; SameSite=Strict; Path=/` });
        }
        if (!authed(request) || !localOrigin(request)) return send(403, 'Not authorised.');
        state.lastUsed = Date.now();
        if (request.method === 'GET' && url.pathname === '/') return send(200, VIEWER_HTML, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        if (request.method === 'GET' && url.pathname === '/frames') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          response.write(': connected\n\n');
          state.clients.add(response);
          request.on('close', () => { state.clients.delete(response); if (!state.clients.size) stopCast(); });
          await exclusive(startCast).catch(error => response.write(`event: problem\ndata: ${JSON.stringify(error.message)}\n\n`));
          return;
        }
        if (request.method === 'POST' && request.headers['x-hive-viewer'] === '1') {
          const body = JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString('utf8') || '{}');
          if (url.pathname === '/input') { await forward(body); return send(204, ''); }
          if (url.pathname === '/go') {
            let target;
            if (body.url !== undefined) {
              try { target = ownedLink(body.url, { ...RECIPES, ...extraRecipes }); } catch (error) { throw new HttpError(400, 'bad_link', error.message); }
            } else {
              const site = recipe(body.site);
              target = body.page === 'home' ? site.homeUrl : site.loginUrl;
            }
            await exclusive(async () => (await page()).goto(target));
            return send(204, '');
          }
        }
        send(404, 'Not found.');
      } catch (error) { if (!response.headersSent) send(error.status ?? 500, 'Request failed.'); else response.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(viewerPort, '127.0.0.1', resolve); });
    state.port = server.address().port;
    state.server = server;
    state.timer = setInterval(() => { if (Date.now() - state.lastUsed > viewerIdleMs) closeViewer(); }, 30_000);
    state.timer.unref();
    log(`viewer listening on 127.0.0.1:${state.port}`);
    return state;
  }

  async function closeViewer() {
    if (!viewer) return;
    const state = viewer; viewer = null;
    clearInterval(state.timer);
    state.off?.();
    for (const client of state.clients) client.end();
    if (browser?.alive) await browser.send('Page.stopScreencast').catch(() => {});
    state.server.closeAllConnections?.();
    await new Promise(resolve => state.server.close(resolve));
    log('viewer closed');
  }

  // ---- control socket -----------------------------------------------------------------------

  async function handle(method, path, input = {}) {
    const action = actions[`${method} ${path}`];
    if (!action) throw new HttpError(404, 'not_found', 'unknown action');
    return action(input ?? {});
  }

  async function saveUpload(name, bytes) {
    const extension = extname(String(name)).toLowerCase();
    if (!UPLOAD_TYPES.has(extension)) throw new HttpError(400, 'bad_attachment', `unsupported file type ${extension || '(none)'}`);
    if (!bytes.length) throw new HttpError(400, 'bad_attachment', 'empty file');
    const id = `${createHash('sha256').update(bytes).digest('hex')}${extension}`;
    writeFileSync(join(stateDir, 'uploads', id), bytes, { mode: 0o600 });
    return { uploadId: id, bytes: bytes.length };
  }

  const control = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://control.invalid');
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      if (request.method === 'POST' && url.pathname === '/upload') {
        return reply(200, await saveUpload(url.searchParams.get('name'), await readBody(request, MAX_UPLOAD_BYTES)));
      }
      const raw = request.method === 'POST' ? (await readBody(request, MAX_JSON_BYTES)).toString('utf8') : '';
      const input = request.method === 'POST' ? JSON.parse(raw || '{}') : Object.fromEntries(url.searchParams);
      reply(200, await handle(request.method, url.pathname, input));
    } catch (error) {
      const status = error.status ?? (error instanceof PostError ? 409 : error instanceof SyntaxError ? 400 : 500);
      reply(status, { error: error.code ?? 'internal_error', message: error.message });
    }
  });

  return {
    handle, saveUpload, store,
    get viewer() { return viewer; },
    async listen(socketPath) {
      rmSync(socketPath, { force: true });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
      chmodSync(socketPath, 0o600);
      log(`control socket ready at ${socketPath}`);
    },
    async close() {
      await closeViewer();
      await new Promise(resolve => (control.listening ? control.close(resolve) : resolve()));
      await queue.catch(() => {});
      if (browser) await browser.close().catch(() => {});
      store.close();
    },
  };
}
