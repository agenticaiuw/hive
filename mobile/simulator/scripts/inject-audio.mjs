#!/usr/bin/env node
/*
 * inject-audio.mjs — drive the nRF9160 pendant's debug mic-injection path.
 *
 * WHY THIS EXISTS
 * ---------------
 * End-to-end tests used to play speech out of the MacBook's speakers so the
 * pendant's physical I2S mic would hear it. That rig has two variables nobody
 * was holding still: the laptop's distance from the pendant, and the host
 * output volume. A whole day of level measurements could not distinguish "the
 * product is too quiet" from "someone moved the laptop", so the conclusion
 * drawn from them — and the production code written to compensate — had to be
 * thrown away. This script replaces the microphone with bytes, so the same
 * utterance arrives at the encoder at the same level on every run.
 *
 * Requires firmware built with CONFIG_PENDANT_MIC_INJECT=y
 * (firmware/nrf9160/harness-inject.conf).
 *
 * TRANSPORT — why JLinkGDBServer and not JLinkExe
 * ----------------------------------------------
 * The mic stage takes 512 frames every 32.77 ms — 15,625 frames/s. Measured on
 * this Mac against this board, against the 31,250 B/s that 16-bit audio needs:
 *
 *   JLinkExe  w4  (2 frames/command)      7,960 B/s    3.9x too slow
 *   JLinkExe  w8  (4 frames/command)     14,054 B/s    2.2x too slow
 *   JLinkExe  loadfile                    resets the MCU — unusable
 *   JLinkGDBServer RSP 'X' block write  ~139,000 B/s   on an IDLE target
 *
 * J-Link Commander costs ~0.5 ms per command regardless of payload, so no
 * batching gets it to rate; its `loadfile` does an implicit reset+halt, which
 * reboots the pendant mid-conversation. Only the GDB server's binary 'X'
 * packet does true block writes against a RUNNING target.
 *
 * THE IDLE NUMBER IS A TRAP. The debug port reaches RAM over the AHB-AP and
 * contends with a CPU running Opus, I2S EasyDMA and the LTE stack. Traced
 * during an actual conversation (the script prints its slowest iterations at
 * the end of every run), the same writes fell
 * to 27-51 kB/s typical with a 114 ms outlier at ~18 kB/s — at or below what
 * 16-bit audio needs. That is a sustained-rate deficit, and no amount of extra
 * ring buffer fixes a sustained-rate deficit.
 *
 * So the wire format is 8-bit G.711 mu-law: 15,625 B/s, ~2.2x headroom against
 * the measured in-call median, and — for the same fixed 4 KB of target RAM —
 * 262 ms of runway instead of 131 ms, which swallows the 114 ms outliers
 * outright. The firmware expands it with the mu-law table it already had. The
 * mapping is deterministic, so repeatability is exact; and the uplink is
 * ~16 kbps Opus, far lossier than G.711, so nothing measurable is given up.
 *
 * BEWARE: every length in the RSP protocol is HEX. `m <addr>,512` reads 0x512
 * = 1298 bytes and looks perfectly well-formed coming back. That bug is why
 * every access below is length-checked and every write is read back — a write
 * that silently does something other than what it says is exactly the failure
 * mode this rig exists to eliminate. (There is likewise no `timeout` command
 * on this Mac; a previous session lost an hour to `timeout 25 JLinkExe ...`
 * silently doing nothing. This script uses in-process deadlines only.)
 *
 * USAGE
 *   node scripts/inject-audio.mjs --phrase "What is my Mac battery level?"
 *   node scripts/inject-audio.mjs --wav ./utterance.wav
 *   node scripts/inject-audio.mjs --selftest       # transport check, no press
 *   node scripts/inject-audio.mjs --phrase "..." --render-only   # no hardware
 *
 * OPTIONS
 *   --phrase <text>     synthesize with `say` (mutually exclusive with --wav)
 *   --wav <path>        use an existing audio file (anything afconvert reads)
 *   --voice <name>      `say` voice (default: system default)
 *   --peak <dbfs>       normalize to this peak, default -6 (the "known level")
 *   --no-normalize      leave source amplitude alone
 *   --lead-ms <ms>      silence before the utterance (default 300)
 *   --trail-ms <ms>     silence after it, for turn detection (default 400);
 *                       the total is rounded up to a whole 512-frame stage
 *   --reply-ms <ms>     how long to hold the call open after the utterance
 *                       ends, so the agent can answer (default 20000)
 *   --elf <path>        ELF to resolve symbols from (default: build-inject)
 *   --out <dir>         where to write artifacts (default: diagnostics/inject)
 */

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const HOME = os.homedir();
const REPO = path.resolve(HOME, 'agentic-gadget');
/*
 * build-inject, not build-cloud: build-cloud is the shared production build
 * directory and other agents rebuild it without this harness overlay, which
 * silently strips the injection symbols out from under a run. The harness
 * image gets its own directory so the two cannot race.
 *   west build -b nrf9160dk/nrf9160/ns -d firmware/nrf9160/build-inject \
 *     firmware/nrf9160 -- \
 *     -DEXTRA_CONF_FILE="<app>/secrets.conf;<app>/harness-inject.conf"
 */
const DEFAULT_ELF = path.join(
  REPO, 'firmware/nrf9160/build-inject/nrf9160/zephyr/zephyr.elf');
const NM = '/opt/nordic/ncs/toolchains/ccc010f809/opt/zephyr-sdk/gnu/arm-zephyr-eabi/bin/arm-zephyr-eabi-nm';

const SAMPLE_RATE = 15625;      // firmware SAMPLE_RATE
const STAGE_FRAMES = 512;       // firmware MIC_STAGE_FRAMES
const RING_FRAMES = 4096;       // firmware PENDANT_INJECT_RING_FRAMES
const BYTES_PER_FRAME = 1;      // G.711 mu-law
const REFILL_MIN_FRAMES = 64;   // don't spend a round trip on less than this
const STAGE_MS = (STAGE_FRAMES / SAMPLE_RATE) * 1000;   // 32.77 ms
const GDB_PORT = 2331;

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const o = {
    phrase: null, wav: null, voice: null, peakDbfs: -6, normalize: true,
    leadMs: 300, trailMs: 400, replyMs: 20000, elf: DEFAULT_ELF, selftest: false,
    renderOnly: false, out: path.join(REPO, 'diagnostics/inject'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--phrase': o.phrase = next(); break;
      case '--wav': o.wav = next(); break;
      case '--voice': o.voice = next(); break;
      case '--peak': o.peakDbfs = Number(next()); break;
      case '--no-normalize': o.normalize = false; break;
      case '--lead-ms': o.leadMs = Number(next()); break;
      case '--trail-ms': o.trailMs = Number(next()); break;
      case '--reply-ms': o.replyMs = Number(next()); break;
      case '--elf': o.elf = path.resolve(next()); break;
      case '--out': o.out = path.resolve(next()); break;
      case '--selftest': o.selftest = true; break;
      case '--render-only': o.renderOnly = true; break;
      case '-h': case '--help':
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8')
          .split('\n').filter((l) => l.startsWith(' *')).join('\n'));
        process.exit(0);
        break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  if (!o.selftest && !o.phrase && !o.wav) {
    throw new Error('need --phrase, --wav, or --selftest');
  }
  if (o.phrase && o.wav) throw new Error('--phrase and --wav are exclusive');
  return o;
}

// ------------------------------------------------------------------- symbols

function resolveSymbols(elf) {
  if (!fs.existsSync(elf)) throw new Error(`no ELF at ${elf}`);
  // Never hardcode: every reflash moves these.
  const out = execFileSync(NM, [elf], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const want = [
    'pendant_inject_ring', 'pendant_inject_arm', 'pendant_inject_head',
    'pendant_inject_tail', 'pendant_inject_eof', 'pendant_inject_underruns',
    'pendant_inject_frames', 'pendant_remote_press',
  ];
  const sym = {};
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{8})\s+\S\s+(\S+)$/.exec(line.trim());
    if (m && want.includes(m[2])) sym[m[2]] = parseInt(m[1], 16);
  }
  const missing = want.filter((w) => sym[w] === undefined);
  if (missing.length) {
    throw new Error(
      `ELF is missing ${missing.join(', ')} — build with ` +
      `-DEXTRA_CONF_FILE=...harness-inject.conf (CONFIG_PENDANT_MIC_INJECT=y)`);
  }
  return sym;
}

// -------------------------------------------------------------- GDB RSP link

class RspLink {
  constructor() { this.server = null; this.sock = null; this.noAck = false; }

  async open() {
    this.server = spawn('JLinkGDBServer', [
      '-device', 'nRF9160_xxAA', '-if', 'SWD', '-speed', '4000',
      '-port', String(GDB_PORT), '-nohalt', '-silent', '-localhostonly',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.serverLog = '';
    this.server.stdout.on('data', (d) => { this.serverLog += d; });
    this.server.stderr.on('data', (d) => { this.serverLog += d; });
    this.server.on('exit', (code) => {
      if (!this.closing) {
        console.error(`JLinkGDBServer exited early (${code}):\n${this.serverLog}`);
      }
    });

    // Poll for the listener instead of sleeping blind.
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        this.sock = await this._connect();
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `JLinkGDBServer never listened on ${GDB_PORT}: ${err.message}\n` +
            this.serverLog);
        }
        await sleep(200);
      }
    }
    this.sock.setNoDelay(true);
    this._wire();
    const sup = await this.cmd('qSupported:xmlRegisters=arm');
    if (!/PacketSize/.test(sup)) throw new Error(`bad qSupported: ${sup}`);
    if (/QStartNoAckMode\+/.test(sup)) {
      if (await this.cmd('QStartNoAckMode') === 'OK') this.noAck = true;
    }
  }

  _connect() {
    return new Promise((res, rej) => {
      const s = net.connect(GDB_PORT, '127.0.0.1');
      const onErr = (e) => { s.destroy(); rej(e); };
      s.once('error', onErr);
      s.once('connect', () => { s.removeListener('error', onErr); res(s); });
    });
  }

  _wire() {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        while (this.buf.length &&
               (this.buf[0] === 0x2b || this.buf[0] === 0x2d)) {
          this.buf = this.buf.subarray(1);   // strip +/- acks
        }
        const hash = this.buf.indexOf(0x23);
        if (this.buf.length === 0 || this.buf[0] !== 0x24 ||
            hash < 0 || this.buf.length < hash + 3) break;
        const payload = this.buf.subarray(1, hash).toString('binary');
        this.buf = this.buf.subarray(hash + 3);
        if (!this.noAck) this.sock.write('+');
        this.waiters.shift()?.(decodeRle(payload));
      }
    });
    this.sock.on('error', (e) => {
      const w = this.waiters.shift();
      if (w) w(`E:socket:${e.message}`);
    });
  }

  cmd(payload, timeoutMs = 10000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`RSP timeout on ${payload.slice(0, 24)}`)),
        timeoutMs);
      this.waiters.push((r) => { clearTimeout(timer); res(r); });
      let c = 0;
      for (let i = 0; i < payload.length; i++) {
        c = (c + payload.charCodeAt(i)) & 0xff;
      }
      this.sock.write(Buffer.from(
        `$${payload}#${c.toString(16).padStart(2, '0')}`, 'binary'));
    });
  }

  /* The GDB server truncates a single 'm' reply well below its advertised
   * PacketSize, so read in chunks and stitch — a short reply is otherwise
   * indistinguishable from a real read failure. */
  async readMem(addr, len) {
    const CHUNK = 512;
    const parts = [];
    for (let off = 0; off < len; off += CHUNK) {
      const n = Math.min(CHUNK, len - off);
      // BOTH fields are hex in RSP. Writing the length in decimal asks for a
      // different number of bytes and the reply still looks like a valid read
      // (`m ...,512` fetches 0x512 = 1298 B) — which is precisely why every
      // access here is length-checked instead of trusted.
      const r = await this.cmd(
        `m${(addr + off).toString(16)},${n.toString(16)}`);
      if (!/^[0-9a-fA-F]+$/.test(r) || r.length !== n * 2) {
        throw new Error(
          `read ${(addr + off).toString(16)}+${n} failed: ` +
          `${r.slice(0, 40)}${r.length > 40 ? '...' : ''} (${r.length / 2} B)`);
      }
      parts.push(Buffer.from(r, 'hex'));
    }
    return Buffer.concat(parts);
  }

  async readU32(addr) { return (await this.readMem(addr, 4)).readUInt32LE(0); }

  /* Verified word write — the analogue of J-Link's
   * "Writing 00000001 -> <addr>", which is the only proof the press landed. */
  async writeU32(addr, value, label) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    const r = await this.cmd(
      `X${addr.toString(16)},4:` + escapeBin(b).toString('binary'));  // 4 == 0x4
    if (r !== 'OK') throw new Error(`write ${label} rejected: ${r}`);
    const back = await this.readU32(addr);
    if (back !== (value >>> 0)) {
      throw new Error(
        `write ${label} did not land: wrote ${hex32(value)} read ${hex32(back)}`);
    }
    console.log(`  Writing ${hex32(value)} -> ${addr.toString(16).toUpperCase()}  (${label})`);
    return back;
  }

  async writeBlock(addr, buf) {
    const r = await this.cmd(
      `X${addr.toString(16)},${buf.length.toString(16)}:` +
      escapeBin(buf).toString('binary'), 15000);
    if (r !== 'OK') throw new Error(`block write rejected: ${r}`);
  }

  async close() {
    this.closing = true;
    try { this.sock?.end(); } catch { /* ignore */ }
    await sleep(150);
    try { this.server?.kill(); } catch { /* ignore */ }
  }
}

/*
 * GDB RSP run-length encoding, server->client only: "X*N" means the character
 * X repeats an additional (N - 29) times. Skipping this is not an option — a
 * 512-byte hex read comes back compressed and then silently disagrees with its
 * own length, which reads exactly like a failed read.
 */
function decodeRle(s) {
  if (!s.includes('*')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && out.length > 0 && i + 1 < s.length) {
      const extra = s.charCodeAt(++i) - 29;
      out += out[out.length - 1].repeat(Math.max(0, extra));
    } else {
      out += c;
    }
  }
  return out;
}

function escapeBin(b) {
  const out = [];
  for (const x of b) {
    if (x === 0x23 || x === 0x24 || x === 0x7d || x === 0x2a) {
      out.push(0x7d, x ^ 0x20);
    } else out.push(x);
  }
  return Buffer.from(out);
}
const hex32 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

// ------------------------------------------------------------------- audio

function render(opts, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  let source = opts.wav;
  if (opts.phrase) {
    source = path.join(workDir, 'say.aiff');
    const args = ['-o', source];
    if (opts.voice) args.push('-v', opts.voice);
    args.push(opts.phrase);
    execFileSync('say', args, { stdio: 'pipe' });
  }
  if (!fs.existsSync(source)) throw new Error(`no such audio file: ${source}`);

  // sox is not installed on this Mac; afconvert ships with macOS and does
  // arbitrary output rates, which is what a 15625 Hz target needs.
  const wav = path.join(workDir, 'stage.wav');
  execFileSync('afconvert', [
    '-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', source, wav,
  ], { stdio: 'pipe' });

  const pcm = readWavPcm(fs.readFileSync(wav));
  console.log(`  rendered ${pcm.length} frames ` +
              `(${(pcm.length / SAMPLE_RATE).toFixed(2)} s) @ ${SAMPLE_RATE} Hz mono`);
  return pcm;
}

function readWavPcm(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('afconvert did not produce a RIFF/WAVE file');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = body;
    if (id === 'data') data = body;
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk');
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
    throw new Error(`WAV is ${channels}ch/${rate}Hz/${bits}bit, ` +
                    `expected 1ch/${SAMPLE_RATE}Hz/16bit`);
  }
  const frames = data.length >> 1;
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2);
  return pcm;
}

/* Normalize to a stated peak. THIS is the "known level" the acoustic rig could
 * never provide: it is a property of the file, not of where the laptop was
 * sitting or where someone left the volume slider. */
function normalize(pcm, peakDbfs) {
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) throw new Error('source audio is silent');
  const target = Math.round(32767 * Math.pow(10, peakDbfs / 20));
  const gainQ15 = Math.round((target / peak) * 32768);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, (pcm[i] * gainQ15) >> 15));
  }
  let after = 0;
  for (const s of out) after = Math.max(after, Math.abs(s));
  console.log(`  normalized peak ${peak} -> ${after} ` +
              `(${peakDbfs} dBFS target ${target})`);
  return out;
}

// ------------------------------------------------------------------- G.711
// Standard (Sun) mu-law. ulawExpand below is a transliteration of the
// firmware's ulaw_to_linear(), so expand(compress(x)) computed here is exactly
// the PCM the pendant will hand its encoder — which is what makes the WAV this
// script writes a golden reference rather than an approximation of one.

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

function ulawCompress(sample) {
  let pcm = sample;
  let sign = 0;
  if (pcm < 0) { pcm = -pcm; sign = 0x80; }
  if (pcm > ULAW_CLIP) pcm = ULAW_CLIP;
  pcm += ULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function ulawExpand(code) {
  const u = (~code) & 0xff;
  const t = ((((u & 0x0f) << 3) + ULAW_BIAS) << ((u >> 4) & 0x07));
  return (u & 0x80) ? (ULAW_BIAS - t) : (t - ULAW_BIAS);
}

/*
 * Lead silence + the utterance + trailing silence, as the mu-law bytes that go
 * on the wire.
 *
 * The total is rounded up to a whole number of 512-frame mic stages. The
 * firmware consumes the ring in stage-sized bites and pads any short bite with
 * silence, counting it as an underrun — so an utterance that is not a multiple
 * of a stage reports one underrun at its tail every single time, purely from
 * the arithmetic. That would be a permanent false positive on the one counter
 * that is supposed to mean "the host fell behind".
 */
function toWireBytes(pcm, leadFrames, trailFrames) {
  const body = leadFrames + pcm.length + trailFrames;
  const total = Math.ceil(body / STAGE_FRAMES) * STAGE_FRAMES;
  const out = Buffer.alloc(total);
  out.fill(ulawCompress(0));                      // mu-law digital silence
  for (let i = 0; i < pcm.length; i++) {
    out[leadFrames + i] = ulawCompress(pcm[i]);
  }
  return out;
}

/* Exactly the samples the device will decode from those bytes. */
function expandedPcm(ulawBytes) {
  const out = Buffer.alloc(ulawBytes.length * 2);
  for (let i = 0; i < ulawBytes.length; i++) {
    out.writeInt16LE(ulawExpand(ulawBytes[i]), i * 2);
  }
  return out;
}

function writeWav(file, pcmBuf) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcmBuf.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcmBuf]));
}

// ------------------------------------------------------------------- driver

async function armAndReset(link, sym) {
  console.log('Arming injection:');
  await link.writeU32(sym.pendant_inject_arm, 0, 'arm=0 (quiesce)');
  await link.writeU32(sym.pendant_inject_eof, 0, 'eof=0');
  await link.writeU32(sym.pendant_inject_head, 0, 'head=0');
  await link.writeU32(sym.pendant_inject_tail, 0, 'tail=0');
  await link.writeU32(sym.pendant_inject_underruns, 0, 'underruns=0');
  await link.writeU32(sym.pendant_inject_frames, 0, 'frames=0');
  await link.writeU32(sym.pendant_inject_arm, 1, 'arm=1');
}

/*
 * Push as much of the utterance as the ring will hold, splitting at the wrap.
 * Indices are frames; the ring is int16, so byte offsets are frames * 2.
 * Head moves only after the samples are on the target, so the firmware never
 * reads a frame that is still in flight.
 */
async function refill(link, sym, wire, cursorFrames, head, tail) {
  const totalFrames = wire.length / BYTES_PER_FRAME;
  const used = (head - tail) & (RING_FRAMES - 1);
  let free = RING_FRAMES - 1 - used;          // one slot kept so full != empty
  let wrote = 0;
  while (free > 0 && cursorFrames + wrote < totalFrames) {
    const at = (head + wrote) & (RING_FRAMES - 1);
    const contiguous = Math.min(free, RING_FRAMES - at);
    const n = Math.min(contiguous, totalFrames - (cursorFrames + wrote));
    if (n <= 0) break;
    const from = (cursorFrames + wrote) * BYTES_PER_FRAME;
    await link.writeBlock(
      sym.pendant_inject_ring + at * BYTES_PER_FRAME,
      wire.subarray(from, from + n * BYTES_PER_FRAME));
    wrote += n;
    free -= n;
  }
  if (wrote === 0) return { head, cursor: cursorFrames, wrote: 0 };
  const newHead = (head + wrote) & (RING_FRAMES - 1);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(newHead, 0);
  await link.writeBlock(sym.pendant_inject_head, b);
  return { head: newHead, cursor: cursorFrames + wrote, wrote };
}

async function main() {
  const opts = parseArgs(process.argv);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const workDir = path.join(opts.out, stamp);

  console.log(`ELF: ${opts.elf}`);
  const sym = resolveSymbols(opts.elf);
  for (const [k, v] of Object.entries(sym)) {
    console.log(`  ${k.padEnd(26)} 0x${v.toString(16)}`);
  }

  /*
   * Render BEFORE opening the debug port. Synthesis and resampling are the
   * parts most likely to fail (a missing voice, an unreadable file), and
   * holding a J-Link session open while they run means a bad argument leaves a
   * GDB server attached to a board another agent may be using. It also makes
   * the whole audio path testable with --render-only, no hardware involved.
   */
  let wire = null; let golden = null; let totalFrames = 0; let durS = 0;
  if (!opts.selftest) {
    console.log('Rendering audio:');
    let pcm = render(opts, workDir);
    if (opts.normalize) pcm = normalize(pcm, opts.peakDbfs);
    const leadFrames = Math.round((opts.leadMs / 1000) * SAMPLE_RATE);
    const trailFrames = Math.round((opts.trailMs / 1000) * SAMPLE_RATE);
    wire = toWireBytes(pcm, leadFrames, trailFrames);
    totalFrames = wire.length / BYTES_PER_FRAME;
    golden = expandedPcm(wire);
    writeWav(path.join(workDir, 'injected.wav'), golden);
    fs.writeFileSync(path.join(workDir, 'injected.ulaw'), wire);
    durS = totalFrames / SAMPLE_RATE;
    console.log(`  ${totalFrames} frames = ${durS.toFixed(2)} s ` +
                `(${(wire.length / durS / 1024).toFixed(1)} kB/s on the wire, ` +
                `${(totalFrames / STAGE_FRAMES)} whole mic stages)`);
    console.log(`  wire sha256   ${sha256(wire)}`);
    console.log(`  golden PCM    ${path.join(workDir, 'injected.wav')}`);
    if (opts.renderOnly) {
      console.log('\n--render-only: nothing was written to the device.');
      return;
    }
  }

  const link = new RspLink();
  await link.open();
  console.log(`GDB server up, RSP connected (noAck=${link.noAck})`);

  // Ctrl-C must not leave the ring armed either; a bare SIGINT would skip the
  // finally block below.
  const onSigint = () => {
    console.error('\nSIGINT — disarming injection before exit.');
    link.writeU32(sym.pendant_inject_arm, 0, 'arm=0 (disarm on SIGINT)')
      .catch(() => {})
      .finally(() => link.close().finally(() => process.exit(130)));
  };
  process.once('SIGINT', onSigint);

  try {
    if (opts.selftest) return await selftest(link, sym);

    await armAndReset(link, sym);

    // ---- prefill so the very first stage is never starved
    let head = 0; let cursor = 0;
    ({ head, cursor } = await refill(link, sym, wire, cursor, head, 0));
    console.log(`Prefilled ${cursor} frames ` +
                `(${(cursor / SAMPLE_RATE * 1000).toFixed(0)} ms of runway)`);
    // Verify the prefill actually landed, byte for byte.
    const nCheck = Math.min(cursor * BYTES_PER_FRAME, 512);
    const back = await link.readMem(sym.pendant_inject_ring, nCheck);
    if (!back.equals(wire.subarray(0, nCheck))) {
      throw new Error('ring prefill verification failed — bytes did not land');
    }
    console.log(`  verified first ${nCheck} ring bytes match the source`);

    // ---- press
    console.log('Pressing (start conversation):');
    await link.writeU32(sym.pendant_remote_press, 1, 'remote_press=1');

    // ---- stream
    const stats = await streamLoop(link, sym, wire, cursor, head, opts);

    // ---- end
    console.log('Pressing (end conversation):');
    await link.writeU32(sym.pendant_remote_press, 1, 'remote_press=1');
    await sleep(500);

    const summary = {
      stamp,
      phrase: opts.phrase ?? null,
      wav: opts.wav ?? null,
      peakDbfs: opts.normalize ? opts.peakDbfs : null,
      sampleRate: SAMPLE_RATE,
      frames: totalFrames,
      durationS: Number(durS.toFixed(3)),
      // Hashes of the exact bytes on the wire and of the PCM the encoder saw.
      // Two runs of the same utterance must produce identical values here; if
      // they do not, nothing downstream is comparable.
      wireSha256: sha256(wire),
      injectedPcmSha256: sha256(golden),
      ...stats,
    };
    fs.writeFileSync(path.join(workDir, 'summary.json'),
                     JSON.stringify(summary, null, 2));
    console.log('\n--- injection summary ---');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\nArtifacts: ${workDir}`);
    if (stats.deviceUnderruns > 0) {
      console.error(`\nWARNING: device reported ${stats.deviceUnderruns} ` +
                    `underruns — the ring starved and silence went out.`);
      process.exitCode = 2;
    }
  } finally {
    /*
     * Disarm no matter how we leave — success, throw, or Ctrl-C. An armed ring
     * that nobody is feeding does not fail loudly: it replaces the microphone
     * with silence, so the NEXT person to press the button (or the next agent
     * to use this board) gets a conversation that records nothing and looks
     * like a hardware fault. Leaving this latched would recreate, in a nastier
     * form, exactly the kind of invisible test-rig variable this tool exists
     * to remove.
     */
    try {
      await link.writeU32(sym.pendant_inject_arm, 0, 'arm=0 (disarm)');
    } catch (err) {
      console.error(`WARNING: could not disarm injection (${err.message}). ` +
                    `The mic may stay replaced by silence until the next ` +
                    `reflash — re-run with --selftest to clear it.`);
    }
    await link.close();
  }
}

async function streamLoop(link, sym, wire, cursor0, head0, opts) {
  const totalFrames = wire.length / BYTES_PER_FRAME;
  let cursor = cursor0;
  let head = head0;
  let started = false;
  let startedAt = 0;
  let maxRefillMs = 0;
  let refills = 0;
  let minRunwayFrames = RING_FRAMES;
  const trace = [];
  const t0 = Date.now();

  console.log('Streaming (waiting for the mic stage to start consuming)...');
  for (;;) {
    const iterAt = Date.now();
    const tRead = Date.now();
    const tail = await link.readU32(sym.pendant_inject_tail);
    const readMs = Date.now() - tRead;
    const used = (head - tail) & (RING_FRAMES - 1);

    if (!started && tail !== 0) {
      started = true;
      startedAt = Date.now();
      console.log(`  consumption started ${((startedAt - t0) / 1000).toFixed(1)} s ` +
                  `after the press`);
    }
    /* Only meaningful while there is still audio left to hand over: once the
     * last frame is queued the ring is SUPPOSED to drain to zero, and counting
     * that as the low-water mark reports 0 on every healthy run. */
    if (started && cursor < totalFrames) {
      minRunwayFrames = Math.min(minRunwayFrames, used);
    }

    /*
     * Top the ring up on every pass rather than letting it drain to a low
     * water mark. The ring only holds 131 ms, so "wait until half empty" spends
     * half the runway before doing any work and leaves nothing to absorb a
     * stall; keeping it near full means the buffer is always the full 131 ms
     * of insurance it was sized to be. Writes are cheap (a 2 KB block is
     * ~14 ms at the measured 139 kB/s), so there is no reason to be frugal
     * with them. REFILL_MIN_FRAMES only avoids burning a round trip on a
     * handful of samples.
     */
    const free = RING_FRAMES - 1 - used;
    if (cursor < totalFrames && free >= REFILL_MIN_FRAMES) {
      const t = Date.now();
      const r = await refill(link, sym, wire, cursor, head, tail);
      const ms = Date.now() - t;
      if (r.wrote > 0) {
        refills++;
        maxRefillMs = Math.max(maxRefillMs, ms);
        head = r.head; cursor = r.cursor;
        trace.push({
          atMs: started ? iterAt - startedAt : -1,
          usedBefore: used, wrote: r.wrote, readMs, writeMs: ms,
          iterMs: Date.now() - iterAt,
        });
      }
    }

    if (cursor >= totalFrames && used === 0) {
      // Everything queued has been consumed: the utterance is fully delivered.
      await link.writeU32(sym.pendant_inject_eof, 1, 'eof=1 (utterance done)');
      break;
    }
    if (started && Date.now() - startedAt > 120000) {
      throw new Error('utterance did not drain within 120 s');
    }
    if (!started && Date.now() - t0 > 90000) {
      throw new Error(
        'mic stage never consumed a frame in 90 s — is the conversation ' +
        'starting? check diagnostics/nrf-uart-latest.log');
    }
    /*
     * Poll fast even BEFORE consumption starts. The ring is prefilled full and
     * holds 131 ms; a 200 ms idle poll meant the firmware could begin draining
     * and empty the ring completely before this loop noticed it had started —
     * which is exactly the 3-underrun run that prompted this comment. Once
     * streaming, the loop is paced by its own RSP round trips.
     */
    await sleep(started ? 2 : 10);
  }

  const deliveredMs = Date.now() - startedAt;
  const frames = await link.readU32(sym.pendant_inject_frames);
  const underruns = await link.readU32(sym.pendant_inject_underruns);
  console.log(`  delivered ${frames} frames in ${(deliveredMs / 1000).toFixed(2)} s, ` +
              `underruns=${underruns}, refills=${refills}, ` +
              `slowest refill ${maxRefillMs} ms, ` +
              `min runway ${minRunwayFrames} frames ` +
              `(${(minRunwayFrames / SAMPLE_RATE * 1000).toFixed(0)} ms)`);
  const worst = [...trace].sort((a, b) => b.iterMs - a.iterMs).slice(0, 6);
  console.log('  slowest iterations (atMs = ms since consumption started):');
  for (const w of worst) {
    console.log(`    at ${String(w.atMs).padStart(5)} ms  used=${String(w.usedBefore).padStart(4)} ` +
                `wrote=${String(w.wrote).padStart(4)}  read=${String(w.readMs).padStart(3)} ms ` +
                `write=${String(w.writeMs).padStart(3)} ms  iter=${w.iterMs} ms`);
  }

  // Hold the call open so the agent can answer; the firmware emits silence
  // now that eof is set, which is also what Realtime's turn detection needs.
  console.log(`Holding ${opts.replyMs} ms for the agent's reply ` +
              `(firmware injecting silence)...`);
  await sleep(opts.replyMs);

  const framesEnd = await link.readU32(sym.pendant_inject_frames);
  const underrunsEnd = await link.readU32(sym.pendant_inject_underruns);
  return {
    deviceFrames: framesEnd,
    deviceUnderruns: underrunsEnd,
    framesAtEof: frames,
    underrunsAtEof: underruns,
    refills,
    maxRefillMs,
    minRunwayFrames,
    minRunwayMs: Math.round(minRunwayFrames / SAMPLE_RATE * 1000),
    deliveredMs,
    slowestIterations: [...trace].sort((a, b) => b.iterMs - a.iterMs).slice(0, 6),
  };
}

/* Transport check with no conversation: prove block writes land and that the
 * CPU keeps running while they do. */
async function selftest(link, sym) {
  console.log('Selftest: block write + verify, target must stay running.');
  const ringBytes = RING_FRAMES * BYTES_PER_FRAME;
  const need = SAMPLE_RATE * BYTES_PER_FRAME;
  const pattern = Buffer.alloc(ringBytes);
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 97 + 13) & 0xff;

  for (const size of [ringBytes / 2, ringBytes]) {
    const chunk = pattern.subarray(0, size);
    await link.writeBlock(sym.pendant_inject_ring, chunk);   // warm
    const t0 = Date.now();
    const reps = 8;
    for (let i = 0; i < reps; i++) {
      await link.writeBlock(sym.pendant_inject_ring, chunk);
    }
    const ms = (Date.now() - t0) / reps;
    const bps = Math.round(size / (ms / 1000));
    console.log(`  ${String(size).padStart(4)} B block write: ` +
                `${ms.toFixed(1)} ms => ${bps} B/s ` +
                `(${(bps / need).toFixed(1)}x the ${need} B/s the mic ` +
                `stage consumes)`);
  }

  const back = await link.readMem(sym.pendant_inject_ring, ringBytes);
  console.log(`  readback ${back.equals(pattern) ? 'MATCHES' : 'DIFFERS'} ` +
              `over all ${ringBytes} bytes`);
  if (!back.equals(pattern)) throw new Error('block write verification failed');

  const u1 = await link.readU32(sym.pendant_remote_press);
  console.log(`  remote_press reads ${hex32(u1)} (expect 00000000 when idle)`);
  await link.writeU32(sym.pendant_inject_arm, 0, 'arm=0 (leave disarmed)');
  // Leave the ring as the firmware expects to find it.
  await link.writeBlock(sym.pendant_inject_ring, Buffer.alloc(ringBytes));
  return {};
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
