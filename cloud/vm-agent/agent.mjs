// The VM worker: one signed-in browser, a post ledger, a control socket and an on-request viewer.
//
// Control is a Unix socket only the owning user can open; nothing listens on a public address.
// The viewer (a live picture of the browser plus mouse and keyboard forwarding) exists so the
// owner can sign in and watch. It binds to loopback, needs a one-time link, and is reached
// through an SSH tunnel. Forwarded input is never logged or stored.
// The sign-in desktop is for sites that refuse a remote-controlled browser (Google's sign-in):
// the same browser and profile run with no remote control, shared by VNC on loopback.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { extname, join } from 'node:path';
import { BrowserSession, desktopBrowserArgs, findBrowserExecutable, proxyArgs } from './browser.mjs';
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

// Ask a process to quit; kill it if it hasn't after `ms`.
const stopProcess = (child, ms) => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => child.kill('SIGKILL'), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  child.kill('SIGTERM');
});

// Resolves once something accepts connections on 127.0.0.1:port.
const listening = async (port, ms, failed) => {
  for (const end = Date.now() + ms; ;) {
    if (failed()) throw new Error('the VNC server stopped while starting');
    const up = await new Promise(resolve => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (up) return;
    if (Date.now() > end) throw new Error('the VNC server did not start listening');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
};

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
  stateDir, executable, headless = false, proxy = null, extraRecipes = {}, timeouts = {},
  approvalTtlMs = 10 * 60_000, viewerPort = 38917, viewerIdleMs = 20 * 60_000, log = () => {},
  desktop: { port: desktopPort = 38918, display = process.env.DISPLAY, vnc: vncCommand = 'x11vnc', browser: desktopExecutable, minutes: desktopMinutes = 30 } = {},
}) {
  for (const dir of [stateDir, join(stateDir, 'uploads'), join(stateDir, 'evidence')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  }
  const store = new PostStore(join(stateDir, 'posts.sqlite'));
  const logins = {};
  let browser = null; let browserError = null; let browserSince = null;
  let queue = Promise.resolve();
  let viewer = null;
  let desktop = null; let desktopClosing = null;

  // One browser, one tab: every operation that touches the page waits its turn.
  const exclusive = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };

  async function page() {
    if (desktop) throw new HttpError(409, 'signing_in', 'the browser is open for sign-in by remote desktop; close that first');
    if (browser?.alive) return browser;
    browser = null;
    try {
      browser = await BrowserSession.launch({ executable, headless, profileDir: join(stateDir, 'profile'), extraArgs: proxyArgs(proxy) });
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
      desktop: desktop ? { open: true, port: desktop.port, expiresAt: desktop.expiresAt } : { open: false },
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
      if (site) {
        await exclusive(async () => (await page()).goto(recipe(site).loginUrl).catch(() => null));
        await viewer.show(null);
      }
      return { port: viewer.port, token: viewer.token, expiresAt: viewer.lastUsed + viewerIdleMs };
    },
    'POST /view/close': async () => { await closeViewer(); return { open: false }; },

    // The browser as an ordinary one, for the owner by remote desktop (see openDesktop).
    'POST /desktop/open': async ({ site }) => {
      const url = site === undefined ? 'about:blank' : recipe(site).loginUrl;
      await closeViewer();
      await exclusive(async () => {
        await desktopClosing;
        if (desktop) return;
        if (browser) { await browser.close().catch(() => {}); browser = null; }
        desktop = await openDesktop(url);
      });
      desktop.expiresAt = Date.now() + desktopMinutes * 60_000;
      return { port: desktop.port, password: desktop.password, expiresAt: desktop.expiresAt };
    },
    'POST /desktop/close': async () => { await closeDesktop(); return { open: false }; },
  };

  // ---- viewer -------------------------------------------------------------------------------

  async function openViewer() {
    const state = {
      port: null, token: null, sessions: new Set(), clients: new Set(), lastUsed: Date.now(), casting: false, size: { width: 1280, height: 800 },
      tabs: new Map(), shown: null, watching: null, switching: Promise.resolve(), timer: null, show: null, stopTitles: null,
    };
    const authed = request => {
      const cookie = /(?:^|;\s*)hv=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
      return !!cookie && state.sessions.has(cookie);
    };
    const localOrigin = request => {
      const origin = request.headers.origin;
      if (!origin) return true;
      try { return ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname); } catch { return false; }
    };
    const broadcast = (event, data) => { const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const client of state.clients) client.write(line); };
    const pushFrame = (jpegBase64, size) => {
      if (size) state.size = size;
      const event = `data: ${JSON.stringify({ d: jpegBase64, w: state.size.width, h: state.size.height })}\n\n`;
      for (const client of state.clients) client.write(event);
    };
    const host = url => { try { return new URL(url).host; } catch { return ''; } };
    const tabList = () => ({
      shown: state.shown?.id ?? null,
      tabs: [...state.tabs.values()].map(tab => ({ id: tab.id, title: String(tab.title ?? '').slice(0, 120), host: host(tab.url), main: tab.main })),
    });
    const pushTabs = () => broadcast('tabs', tabList());
    // The viewer never launches a second browser: it uses the running one or waits its turn.
    const live = () => (browser?.alive ? browser : exclusive(page));

    // Every tab and popup window of the browser, so a sign-in popup (such as X's "Continue with
    // Google") appears in the viewer: a new one is shown as it opens, and when the shown one
    // closes, the tab that opened it is shown again.
    const watch = async main => {
      if (state.watching?.browser === main) return;
      state.watching?.off();
      state.shown?.off(); // the browser restarted: its old tabs are gone
      state.tabs.clear(); state.shown = null;
      let ready = false;
      const off = main.onBrowserEvent((method, params) => {
        if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
          const info = params.targetInfo;
          if (info.type !== 'page' || info.url.startsWith('devtools://')) return;
          const fresh = !state.tabs.has(info.targetId);
          state.tabs.set(info.targetId, { id: info.targetId, title: info.title, url: info.url, opener: info.openerId ?? null, main: info.targetId === main.targetId });
          if (fresh && ready) show(info.targetId); else pushTabs();
        } else if (method === 'Target.targetDestroyed') {
          const gone = state.tabs.get(params.targetId);
          if (!gone) return;
          state.tabs.delete(params.targetId);
          if (state.shown?.id === params.targetId) show(state.tabs.has(gone.opener) ? gone.opener : main.targetId); else pushTabs();
        }
      });
      state.watching = { browser: main, off };
      await main.browserSend('Target.setDiscoverTargets', { discover: true });
      if (!state.tabs.has(main.targetId)) state.tabs.set(main.targetId, { id: main.targetId, title: '', url: '', opener: null, main: true });
      ready = true;
    };
    // Chrome doesn't always report a title change, so titles are read again as pictures come in:
    // at most every 2 s, and always once after the latest picture.
    let titlesReadAt = 0; let titlesDue = null;
    const readTitles = main => {
      if (titlesDue) return;
      titlesDue = setTimeout(async () => {
        titlesDue = null; titlesReadAt = Date.now();
        if (!main.alive) return;
        const { targetInfos = [] } = await main.browserSend('Target.getTargets').catch(() => ({}));
        let changed = false;
        for (const info of targetInfos) {
          const tab = state.tabs.get(info.targetId);
          if (tab && (tab.title !== info.title || tab.url !== info.url)) { tab.title = info.title; tab.url = info.url; changed = true; }
        }
        if (changed) pushTabs();
      }, Math.max(0, titlesReadAt + 2_000 - Date.now()));
      titlesDue.unref();
    };
    state.stopTitles = () => clearTimeout(titlesDue);
    const cast = async tab => {
      await tab.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1200 });
      pushFrame((await tab.screenshot({ quality: 60 })).toString('base64'), await tab.viewport());
    };
    const release = async () => {
      const shown = state.shown;
      if (!shown) return;
      state.shown = null;
      shown.off();
      await shown.tab.send('Page.stopScreencast').catch(() => {});
      if (!shown.main) await shown.tab.detach().catch(() => {});
    };
    const showNow = async id => {
      const main = await live();
      await watch(main);
      if (!state.tabs.has(id)) id = main.targetId;
      if (state.shown?.id !== id) {
        await release();
        let tab = main;
        if (id !== main.targetId) {
          try { tab = await main.attach(id); } catch { id = main.targetId; } // it closed already
        }
        const off = tab.onEvent((method, params) => {
          if (method !== 'Page.screencastFrame') return;
          tab.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
          if (state.shown?.tab !== tab) return;
          pushFrame(params.data, { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight });
          readTitles(main);
        });
        state.shown = { id, tab, off, main: tab === main };
      }
      // A tab in the background sends no pictures, so the shown one comes to the front.
      await main.browserSend('Target.activateTarget', { targetId: id }).catch(() => {});
      pushTabs();
      if (state.casting) await cast(state.shown.tab);
    };
    // Switches happen one at a time, in order. null shows the main tab.
    // A tab closing mid-switch is no problem: the switch its closing starts comes next.
    const show = id => (state.switching = state.switching.then(() => showNow(id))
      .catch(error => { if (error.code !== 'tab_closed') broadcast('problem', error.message); }));
    state.show = show;
    const startCast = () => { state.casting = true; return show(state.shown?.id ?? null); };
    const stopCast = async () => {
      state.casting = false;
      await state.shown?.tab.send('Page.stopScreencast').catch(() => {});
    };
    const forward = async event => {
      const tab = state.shown?.tab ?? await live();
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
          response.write(`event: tabs\ndata: ${JSON.stringify(tabList())}\n\n`);
          await startCast();
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
            await show(null);
            return send(204, '');
          }
          if (url.pathname === '/tab') {
            const tab = state.tabs.get(String(body.id ?? ''));
            if (!tab) throw new HttpError(404, 'no_tab', 'that tab has closed');
            if (!body.close) await show(tab.id);
            else if (tab.main) throw new HttpError(400, 'main_tab', 'the main tab stays open');
            else await (await live()).browserSend('Target.closeTarget', { targetId: tab.id });
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
    state.stopTitles();
    state.casting = false;
    await state.switching;
    state.watching?.off();
    for (const client of state.clients) client.end();
    if (state.watching?.browser.alive) {
      const shown = state.shown;
      if (shown) { shown.off(); await shown.tab.send('Page.stopScreencast').catch(() => {}); if (!shown.main) await shown.tab.detach().catch(() => {}); }
      const main = state.watching.browser;
      await main.browserSend('Target.setDiscoverTargets', { discover: false }).catch(() => {});
      // Posting works in the main tab, so it goes back in front.
      await main.browserSend('Target.activateTarget', { targetId: main.targetId }).catch(() => {});
    }
    state.server.closeAllConnections?.();
    await new Promise(resolve => state.server.close(resolve));
    log('viewer closed');
  }

  // ---- sign-in desktop ----------------------------------------------------------------------

  // Some sign-ins (Google's, behind "Continue with Google") refuse a browser that is remote-
  // controlled, as the worker's is. For those the same browser and profile are started with no
  // remote control at all, on the worker's display, and x11vnc shares that display on loopback
  // with a one-time password, reached through an SSH tunnel. Nothing about the browser is
  // disguised: it is an ordinary browser the owner uses, and the worker drives nothing while it
  // is open. The sign-in stays in the profile when the worker's own browser starts again.
  async function openDesktop(url) {
    if (!display) throw new HttpError(503, 'no_display', 'the worker has no display to share; start it with run.sh');
    const env = { ...process.env, DISPLAY: display };
    const chrome = spawn(desktopExecutable ?? findBrowserExecutable(executable),
      desktopBrowserArgs({ profileDir: join(stateDir, 'profile'), proxy, url }), { stdio: 'ignore', env });
    const password = randomBytes(6).toString('base64url'); // VNC passwords are 8 characters
    const passwordFile = join(stateDir, 'desktop.pass');
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    const vnc = spawn(vncCommand, ['-display', display, '-localhost', '-rfbport', String(desktopPort), '-passwdfile', `rm:${passwordFile}`,
      '-forever', '-shared', '-noxdamage', '-quiet'], { stdio: 'ignore', env });
    const state = { chrome, vnc, port: desktopPort, password, expiresAt: Date.now() + desktopMinutes * 60_000, timer: null };
    let failed = false;
    for (const child of [chrome, vnc]) {
      child.once('error', () => { failed = true; });
      // The owner closed the browser, or VNC stopped: the worker may use its browser again.
      child.once('exit', () => { failed = true; if (desktop === state) closeDesktop(); });
    }
    try { await listening(desktopPort, 10_000, () => failed); } catch (error) {
      await Promise.all([stopProcess(vnc, 2_000), stopProcess(chrome, 10_000)]);
      rmSync(passwordFile, { force: true });
      throw new HttpError(503, 'desktop_failed', error.message);
    }
    state.timer = setInterval(() => { if (Date.now() > state.expiresAt) closeDesktop(); }, 30_000);
    state.timer.unref();
    log(`sign-in desktop open on 127.0.0.1:${desktopPort}`);
    return state;
  }

  function closeDesktop() {
    if (!desktop) return Promise.resolve();
    desktopClosing ??= (async () => {
      const state = desktop;
      clearInterval(state.timer);
      // Asked, not killed: the browser writes its cookies (the sign-in) as it quits.
      await Promise.all([stopProcess(state.vnc, 3_000), stopProcess(state.chrome, 15_000)]);
      desktop = null; desktopClosing = null;
      log('sign-in desktop closed');
    })();
    return desktopClosing;
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
      await closeDesktop();
      await new Promise(resolve => (control.listening ? control.close(resolve) : resolve()));
      await queue.catch(() => {});
      if (browser) await browser.close().catch(() => {});
      store.close();
    },
  };
}
