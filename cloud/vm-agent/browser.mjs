// One ordinary Chromium window with a persistent profile, driven over CDP.
// The profile directory is what holds the owner's logins; nothing here reads or exports
// cookies or passwords, and nothing alters how the browser identifies itself to sites.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Cdp } from './cdp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EXECUTABLE_CANDIDATES = [
  process.env.HIVE_VM_BROWSER,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export function findBrowserExecutable(explicit) {
  const found = [explicit, ...EXECUTABLE_CANDIDATES].filter(Boolean).find(path => existsSync(path));
  if (!found) throw new Error('no Chromium executable found; set HIVE_VM_BROWSER');
  return found;
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// Chromium flags that send all of the browser's traffic through `proxy` (HIVE_VM_PROXY, such as
// vpn.sh's socks5://127.0.0.1:11080), host names included, and keep WebRTC from going around it.
// Without a proxy, none. If the proxy is down, pages fail instead of quietly going direct.
export function proxyArgs(proxy) {
  if (!proxy) return [];
  if (!/^(socks5|http):\/\/[\w.-]+:\d{1,5}$/.test(proxy)) throw new Error(`HIVE_VM_PROXY must look like socks5://127.0.0.1:11080, not ${proxy}`);
  return [`--proxy-server=${proxy}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
}

// The same browser for the owner to use by remote desktop: same profile, proxy and password store
// (so a sign-in made there is the worker's too), and no remote control at all: no debugging port.
export function desktopBrowserArgs({ profileDir, proxy = null, width = 1440, height = 900, url = 'about:blank' }) {
  return [
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    process.platform === 'darwin' ? '--use-mock-keychain' : '--password-store=basic',
    '--window-position=0,0', `--window-size=${width},${height}`, ...proxyArgs(proxy), url,
  ];
}

export class BrowserSession {
  #cdp; #child; #session; #stderr = '';

  constructor({ cdp, child, session, profileDir, targetId }) {
    this.#cdp = cdp; this.#child = child; this.#session = session; this.profileDir = profileDir; this.targetId = targetId;
  }
  static async launch({ executable, profileDir, headless = false, width = 1280, height = 800, extraArgs = [] }) {
    const binary = findBrowserExecutable(executable);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);
    const portFile = join(profileDir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    const args = [
      '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`,
      process.platform === 'darwin' ? '--use-mock-keychain' : '--password-store=basic',
      ...(headless ? ['--headless=new'] : []), ...extraArgs, 'about:blank',
    ];
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; let exited = null;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile)) {
      if (exited) throw new Error(`browser exited during startup (${exited.code ?? exited.signal}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
      if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('browser did not open its control port'); }
      await sleep(100);
    }
    let cdp;
    for (let attempt = 0; ; attempt++) {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      try { cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`); break; } catch (error) {
        if (attempt > 20 || exited) { child.kill('SIGKILL'); throw error; }
        await sleep(150);
      }
    }
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(info => info.type === 'page')
      ?? { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId };
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const browser = new BrowserSession({ cdp, child, session: sessionId, profileDir, targetId: target.targetId });
    child.stderr.on('data', chunk => { browser.#stderr = (browser.#stderr + chunk).slice(-4000); });
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    return browser;
  }

  get alive() { return !this.#cdp.closed && this.#child.exitCode === null && this.#child.signalCode === null; }

  send(method, params = {}, options) { return this.#cdp.send(method, params, this.#session, options); }

  onEvent(listener) {
    return this.#cdp.on((method, params, session) => { if (session === this.#session) listener(method, params); });
  }

  // The browser as a whole rather than this tab: its tabs and popup windows (Target.*).
  browserSend(method, params = {}) { return this.#cdp.send(method, params); }

  onBrowserEvent(listener) {
    return this.#cdp.on((method, params, session) => { if (!session) listener(method, params); });
  }

  // Another tab or popup window of the same browser, driven the same way as this one.
  // Let go of it with detach(); close() would close the whole browser.
  async attach(targetId) {
    const { sessionId } = await this.#cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return new BrowserSession({ cdp: this.#cdp, child: this.#child, session: sessionId, profileDir: this.profileDir, targetId });
  }

  detach() { return this.#cdp.send('Target.detachFromTarget', { sessionId: this.#session }); }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (exceptionDetails) throw new Error(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  // Run a self-contained function inside the page with JSON-serialisable arguments.
  call(fn, ...args) { return this.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`); }

  async url() { return this.evaluate('location.href'); }

  async goto(url, { timeoutMs = 45_000 } = {}) {
    const loaded = this.#cdp.waitForEvent('Page.loadEventFired', this.#session, { timeoutMs }).catch(() => null);
    const { errorText } = await this.send('Page.navigate', { url });
    if (errorText) throw new Error(`navigation failed: ${errorText}`);
    await loaded;
  }

  // Poll a page-side predicate until it returns a truthy value; resolves with that value or null on timeout.
  async waitFor(fn, args = [], { timeoutMs = 20_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = await this.call(fn, ...args); } catch { /* the page may be mid-navigation */ }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  async clickSelector(selector) {
    const point = await this.call(sel => {
      const element = document.querySelector(sel);
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, selector);
    if (!point) throw new Error(`cannot click ${selector}: not visible`);
    await this.mouse('mouseMoved', point.x, point.y);
    await this.mouse('mousePressed', point.x, point.y, { button: 'left', clickCount: 1 });
    await this.mouse('mouseReleased', point.x, point.y, { button: 'left', clickCount: 1 });
  }

  mouse(type, x, y, extra = {}) { return this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }

  insertText(text) { return this.send('Input.insertText', { text }); }

  async press(name, { modifiers = [], commands } = {}) {
    const key = KEYS[name];
    if (!key) throw new Error(`unknown key ${name}`);
    const mask = modifiers.reduce((sum, modifier) => sum | MODIFIERS[modifier], 0);
    const { text, ...base } = key;
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}), modifiers: mask, ...(commands ? { commands } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, modifiers: mask });
  }

  // Select everything in the focused editor with the browser's own editing command.
  selectAll() {
    return this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      .then(() => this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }));
  }

  // Choose local files in a page's file input, as the file picker would. False if the input is absent.
  async setFiles(selector, paths) {
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return false;
    await this.send('DOM.setFileInputFiles', { nodeId, files: paths });
    return true;
  }

  async viewport() {
    const { cssVisualViewport } = await this.send('Page.getLayoutMetrics');
    return { width: cssVisualViewport.clientWidth, height: cssVisualViewport.clientHeight };
  }

  async screenshot({ quality = 70 } = {}) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'jpeg', quality });
    return Buffer.from(data, 'base64');
  }

  async close() {
    try { await this.#cdp.send('Browser.close', {}, undefined, { timeoutMs: 5_000 }); } catch { /* fall through to signal */ }
    this.#cdp.close();
    if (this.#child.exitCode === null) {
      const gone = new Promise(resolve => this.#child.once('exit', resolve));
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), 5_000);
      await gone; clearTimeout(timer);
    }
  }
}
