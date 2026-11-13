// A small VNC (RFB 3.8) client: how Hive's VM agent sees the VM's screen and uses its mouse and
// keyboard, the way a person at a remote desktop would. It connects without a password to an
// x11vnc listening on a Unix socket that only this user can open (desktop-mcp.mjs starts it), and
// asks for raw pixels: the server is on the same machine.
import { connect } from 'node:net';
import { deflateSync } from 'node:zlib';

// X keysyms for named keys. "cmd" is Control: the VM's apps are Linux ones.
const NAMED = {
  enter: 0xff0d, return: 0xff0d, tab: 0xff09, backspace: 0xff08, escape: 0xff1b, esc: 0xff1b,
  delete: 0xffff, home: 0xff50, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  pageup: 0xff55, page_up: 0xff55, pagedown: 0xff56, page_down: 0xff56, end: 0xff57, insert: 0xff63,
  space: 0x20, shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3, cmd: 0xffe3, command: 0xffe3,
  alt: 0xffe9, option: 0xffe9, super: 0xffeb, meta: 0xffeb, win: 0xffeb,
};
for (let n = 1; n <= 12; n++) NAMED[`f${n}`] = 0xffbe + n - 1;

/** The keysym that types one character: Latin-1 as itself, anything else as a Unicode keysym. */
export function charKeysym(char) {
  const code = char.codePointAt(0);
  if (code === 10 || code === 13) return 0xff0d;
  if (code === 9) return 0xff09;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return 0x01000000 + code;
}

/**
 * The characters in `text` the VM's keyboard can't type: anything but printable ASCII, Return and
 * Tab. Accented letters aren't on its US keyboard, and Chrome on Linux reads typed characters only
 * up to U+FFFF, so most emoji can't arrive by keyboard at all; a page's emoji picker can add them.
 */
export function untypable(text) {
  return [...new Set([...String(text)].filter(char => !/^[\x20-\x7e\n\r\t]$/.test(char)))];
}

/** "ctrl+shift+t" → [ctrl, shift, t] keysyms; one name or one character per part. */
export function comboKeysyms(combo) {
  const parts = String(combo).trim().split(/\+(?!$)/).map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no key given');
  return parts.map(part => {
    const named = NAMED[part.toLowerCase()];
    if (named !== undefined) return named;
    if ([...part].length === 1) return charKeysym(part.length === 1 && /[A-Z]/.test(part) && parts.length > 1 ? part.toLowerCase() : part);
    throw new Error(`unknown key "${part}"`);
  });
}

const BUTTONS = { left: 1, middle: 2, right: 4 };

/** An RGB picture as a PNG. */
export function encodePng(width, height, rgb) {
  const table = encodePng.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) rgb.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Vnc {
  #socket; #buffer = Buffer.alloc(0); #want = null; #closed = null; #updates = 0; #waiters = [];
  width = 0; height = 0; pixels = Buffer.alloc(0); x = 0; y = 0; buttons = 0;

  /** Connects to a VNC server on a Unix socket (`path`) or 127.0.0.1:`port`; needs no password. */
  static async open({ path, port }) {
    const vnc = new Vnc();
    await vnc.#start(path ? connect(path) : connect(port, '127.0.0.1'));
    return vnc;
  }

  async #start(socket) {
    this.#socket = socket;
    this.#closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('data', chunk => { this.#buffer = Buffer.concat([this.#buffer, chunk]); this.#want?.(); });
    socket.on('close', () => { this.#want?.(); for (const w of this.#waiters.splice(0)) w.reject(new Error('the VNC connection closed')); });
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    await this.#read(12);
    socket.write('RFB 003.008\n');
    const count = (await this.#read(1))[0];
    if (count === 0) throw new Error(`VNC refused: ${(await this.#read((await this.#read(4)).readUInt32BE(0))).toString()}`);
    const types = [...await this.#read(count)];
    if (!types.includes(1)) throw new Error('the VNC server wants a password; Hive connects only to its own one on a private socket');
    socket.write(Buffer.from([1]));
    if ((await this.#read(4)).readUInt32BE(0) !== 0) throw new Error('VNC refused the connection');
    socket.write(Buffer.from([1])); // shared: the owner may be watching too
    const init = await this.#read(24);
    this.#resize(init.readUInt16BE(0), init.readUInt16BE(2));
    await this.#read(init.readUInt32BE(20));
    const format = Buffer.alloc(20);
    Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(format, 4);
    const encodings = Buffer.alloc(12);
    encodings[0] = 2; encodings.writeUInt16BE(2, 2); encodings.writeInt32BE(0, 4); encodings.writeInt32BE(-223, 8); // raw, desktop size
    socket.write(Buffer.concat([format, encodings]));
    this.#loop().catch(() => socket.destroy());
  }

  #read(n) {
    return new Promise((resolve, reject) => {
      this.#want = () => {
        if (this.#buffer.length >= n) {
          const out = this.#buffer.subarray(0, n); this.#buffer = this.#buffer.subarray(n); this.#want = null; resolve(out);
        } else if (this.#socket.destroyed) { this.#want = null; reject(new Error('the VNC connection closed')); }
      };
      this.#want();
    });
  }

  #resize(width, height) { this.width = width; this.height = height; this.pixels = Buffer.alloc(width * height * 3); }

  async #loop() {
    for (;;) {
      const type = (await this.#read(1))[0];
      if (type === 0) {
        const rects = (await this.#read(3)).readUInt16BE(1);
        for (let r = 0; r < rects; r++) {
          const head = await this.#read(12);
          const x = head.readUInt16BE(0), y = head.readUInt16BE(2), w = head.readUInt16BE(4), h = head.readUInt16BE(6);
          const encoding = head.readInt32BE(8);
          if (encoding === -223) { this.#resize(w, h); continue; }
          if (encoding !== 0) throw new Error(`unexpected VNC encoding ${encoding}`);
          const data = await this.#read(w * h * 4);
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const from = (row * w + col) * 4; const to = ((y + row) * this.width + x + col) * 3;
              if (to + 2 >= this.pixels.length) continue;
              this.pixels[to] = data[from + 2]; this.pixels[to + 1] = data[from + 1]; this.pixels[to + 2] = data[from];
            }
          }
        }
        this.#updates++;
        for (const w of this.#waiters.splice(0)) w.resolve();
      } else if (type === 1) {
        const head = await this.#read(5); await this.#read(head.readUInt16BE(3) * 6);
      } else if (type === 2) { /* bell */ } else if (type === 3) {
        await this.#read(3); await this.#read((await this.#read(4)).readUInt32BE(0));
      } else throw new Error(`unexpected VNC message ${type}`);
    }
  }

  /** The whole screen now, as a PNG. */
  async capture() {
    const done = new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    const request = Buffer.alloc(10);
    request[0] = 3; request.writeUInt16BE(this.width, 6); request.writeUInt16BE(this.height, 8);
    this.#socket.write(request);
    await Promise.race([done, sleep(10_000).then(() => { throw new Error('the screen did not arrive in 10 s'); })]);
    return { width: this.width, height: this.height, png: encodePng(this.width, this.height, this.pixels) };
  }

  #pointer(x, y, buttons) {
    this.x = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    this.y = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    this.buttons = buttons;
    const message = Buffer.alloc(6);
    message[0] = 5; message[1] = buttons; message.writeUInt16BE(this.x, 2); message.writeUInt16BE(this.y, 4);
    this.#socket.write(message);
  }

  #key(keysym, down) {
    const message = Buffer.alloc(8);
    message[0] = 4; message[1] = down ? 1 : 0; message.writeUInt32BE(keysym >>> 0, 4);
    this.#socket.write(message);
  }

  async move(x, y) { this.#pointer(x, y, 0); await sleep(30); }

  async click(x, y, { button = 'left', count = 1 } = {}) {
    const mask = BUTTONS[button];
    if (!mask) throw new Error(`unknown button "${button}"`);
    this.#pointer(x, y, 0); await sleep(40);
    for (let n = 0; n < count; n++) { this.#pointer(x, y, mask); await sleep(40); this.#pointer(x, y, 0); await sleep(60); }
  }

  async drag(fromX, fromY, toX, toY) {
    this.#pointer(fromX, fromY, 0); await sleep(40);
    this.#pointer(fromX, fromY, 1); await sleep(80);
    for (let step = 1; step <= 12; step++) { this.#pointer(fromX + (toX - fromX) * step / 12, fromY + (toY - fromY) * step / 12, 1); await sleep(25); }
    await sleep(60); this.#pointer(toX, toY, 0); await sleep(40);
  }

  /** Scrolls at (x, y): positive `notches` down, negative up. */
  async scroll(x, y, notches) {
    const mask = notches < 0 ? 8 : 16;
    this.#pointer(x, y, 0); await sleep(30);
    for (let n = 0; n < Math.min(Math.abs(Math.round(notches)), 50); n++) { this.#pointer(x, y, mask); this.#pointer(x, y, 0); await sleep(20); }
  }

  async type(text) {
    const missing = untypable(text);
    if (missing.length) throw new Error(`can't type ${missing.map(char => `"${char}"`).join(' ')} on the VM's keyboard; nothing was typed`);
    for (const char of text) {
      const keysym = charKeysym(char);
      this.#key(keysym, true); this.#key(keysym, false);
      await sleep(keysym > 0xff && keysym < 0xff00 ? 25 : 8);
    }
  }

  async press(combo) {
    const keys = comboKeysyms(combo);
    for (const key of keys) { this.#key(key, true); await sleep(15); }
    for (const key of [...keys].reverse()) { this.#key(key, false); await sleep(15); }
  }

  close() { this.#socket?.destroy(); return this.#closed; }
}
