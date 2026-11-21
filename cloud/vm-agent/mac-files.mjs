// Copy between the Mac and VM through Hive's existing cloud bucket, using the Mac's command tool
// and its cf login (the same transport as desktop/hive-files.mjs). File bytes never enter the Mac
// call mailbox. Each copy gets a new cloud key; neither source is deleted and no destination on
// the Mac is replaced. Sending the file to someone else is a separate, one-way action.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { BUCKET, checkKey, contentType, fetchFile, putFile } from './files.mjs';

export const TRANSFER_TOOL = {
  name: 'transfer_file',
  description: "Copy a file between the owner's Mac and this VM through Hive's cloud storage, without Finder. "
    + "direction=to_vm reads mac_path and returns vm_path; direction=to_mac reads vm_path and creates mac_path. "
    + 'Paths must be absolute. The destination folder on the Mac must exist and the file must not exist. '
    + 'Mac-to-VM copies are verified by size and SHA-256. After an upload error, checks the cloud copy before one bounded retry. '
    + 'Use recovery_key from a failed to_vm call to fetch and verify that copy without uploading again. '
    + 'First use check_only=true with the intended paths: runs a harmless command on the Mac without reading or copying a file. '
    + 'Sources and the cloud copy are kept. Uses the Mac\'s cf login; does not send or publish to anyone else.',
  inputSchema: { type: 'object', properties: {
    direction: { type: 'string', enum: ['to_vm', 'to_mac'] },
    mac_path: { type: 'string' }, vm_path: { type: 'string', description: 'Required for to_mac' },
    check_only: { type: 'boolean', description: 'Probe this execution before retrying a repaired task; no file is copied' },
    recovery_key: { type: 'string', description: 'Cloud key from a previous to_vm call for this source file' },
    step: { type: 'string', description: 'What file you are copying and why' },
  }, required: ['direction', 'mac_path', 'step'], additionalProperties: false },
};

// Shell words, never code. Names with quotes, spaces, dollar signs and newlines stay literal.
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const filePath = p => typeof p === 'string' && p.startsWith('/') && !p.endsWith('/') && !p.includes('\0');
// App launches may not inherit nvm's PATH. The existing Mac file helper uses cf, whose node must
// also be on PATH. Only installed versions are considered; nothing is installed by this tool.
const CF = `if ! command -v cf >/dev/null 2>&1; then
  cf_bin=$(/bin/sh -c 'for binary in "$HOME"/.nvm/versions/node/*/bin/cf; do
    if [ -f "$binary" ]; then printf "%s\\n" "\${binary%/*}"; fi
  done' | /usr/bin/tail -n 1)
  if [ -n "$cf_bin" ]; then export PATH="$cf_bin:$PATH"; fi
fi
`;

const commandOutput = result => {
  for (const item of result?.content ?? []) {
    if (item.type !== 'text') continue;
    try {
      const out = JSON.parse(item.text);
      if (out && typeof out === 'object' && 'exit_code' in out) return out;
    } catch {}
  }
  return null;
};

// Hash on the Mac before uploading, so an interrupted reply can still be recovered by verifying
// the cloud copy. Only metadata crosses the mailbox; neither credentials nor file bytes do.
const SOURCE_INFO = `const fs = require('node:fs');
const path = process.argv[1];
if (!fs.statSync(path).isFile()) throw new Error('Source is not a regular file');
const hash = require('node:crypto').createHash('sha256');
let size = 0;
const stream = fs.createReadStream(path);
stream.on('data', chunk => { size += chunk.length; hash.update(chunk); });
stream.on('error', error => { console.error(error.message); process.exitCode = 1; });
stream.on('end', () => console.log(JSON.stringify({ size, sha256: hash.digest('hex') })));`;

export async function transferFile(args, command, { fetch = (key, expected) => fetchFile(key, undefined, { expected }), put = putFile, uuid = randomUUID } = {}) {
  const { direction, mac_path: macPath, vm_path: vmPath, step } = args;
  if (!['to_vm', 'to_mac'].includes(direction)) throw new Error('direction must be to_vm or to_mac');
  if (!filePath(macPath) || (direction === 'to_mac' && !filePath(vmPath))) throw new Error('Give absolute file paths');
  if (typeof step !== 'string' || !step.trim()) throw new Error('Say what file you are copying in step');
  if (args.recovery_key !== undefined && (direction !== 'to_vm' || !checkKey(args.recovery_key).startsWith('transfers/'))) {
    throw new Error('recovery_key must be a transfers/ key from a previous to_vm call');
  }
  if (args.check_only !== undefined && typeof args.check_only !== 'boolean') throw new Error('check_only must be a boolean');
  // A board heartbeat can outlive the Mac connection. Require a fresh command reply;
  // this proves the live route, but neither file existence nor a completed copy.
  if (args.check_only === true) {
    const result = await command({ command: '/usr/bin/true', irreversible: false, step, timeout_seconds: 15 });
    if (result?.isError) return result;
    const out = commandOutput(result);
    if (out?.exit_code !== 0 || out.timed_out === true) throw new Error('The Mac did not answer the transfer probe successfully; no file was copied.');
    return { content: [{ type: 'text', text: JSON.stringify({
      ready: true, copied: false, direction, mac_path: macPath,
    }) }] };
  }
  const key = args.recovery_key ?? checkKey(`transfers/${uuid()}/${posix.basename(direction === 'to_vm' ? macPath : vmPath)}`);
  const run = script => command({ command: `set -e\numask 077\n${CF}${script}`, irreversible: false, step, timeout_seconds: 240 });
  let script;
  if (direction === 'to_vm') {
    const info = await run(`node -e ${quote(SOURCE_INFO)} ${quote(macPath)}`);
    if (info.isError) return { ...info, content: [...info.content, { type: 'text', text: `Could not read the Mac source ${macPath}; no upload started.` }] };
    let expected;
    try { expected = JSON.parse(commandOutput(info)?.stdout); } catch {}
    if (!Number.isSafeInteger(expected?.size) || expected.size < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error('The Mac did not return the source size and SHA-256; no upload started');
    }
    const success = (local, recovered = false) => ({ content: [{ type: 'text', text: JSON.stringify({
      key, mac_path: macPath, vm_path: local, ...expected, recovered,
    }) }] });
    if (args.recovery_key) {
      // A recovery key may still be in use by the earlier call. Only inspect it; if it cannot be
      // verified, a new invocation without recovery_key will upload under a fresh key.
      try { return success(await fetch(key, expected), true); }
      catch (error) { throw new Error(`Could not recover cloud key ${key}: ${error.message}. Retry without recovery_key to start a new copy.`); }
    }
    script = `cf r2 objects put ${quote(key)} --bucket-name ${quote(BUCKET)} --file ${quote(macPath)} --content-type ${quote(contentType(macPath))}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let result;
      try { result = await run(script); }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: `The Mac's transfer result was not received: ${error.message}` }] }; }
      // A timeout may only have lost the reply. Always try the exact key, and accept it only
      // when its bytes match the source. Never re-run an upload whose Mac call is uncertain.
      try { return success(await fetch(key, expected), !!result.isError); }
      catch (error) {
        const out = commandOutput(result);
        const transient = /timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|\b50[234]\b/i.test(`${out?.stderr ?? ''}\n${out?.stdout ?? ''}`);
        if (result.isError && attempt === 1 && Number.isInteger(out?.exit_code) && out.exit_code !== 0 && out.timed_out === false && transient) continue;
        const detail = `Mac-to-VM transfer could not be verified after ${attempt} upload attempt(s). `
          + `Source: ${expected.size} bytes, SHA-256 ${expected.sha256}. Cloud key: ${key}. VM fetch: ${error.message}. `
          + `Retry transfer_file with direction=to_vm, the same mac_path and recovery_key=${key} to inspect this copy without uploading again.`;
        return { isError: true, content: [...(result.content ?? []), { type: 'text', text: detail }] };
      }
    }
  } else {
    // Check the destination before downloading. Link a completed temporary file into place so a
    // failed download cannot leave a partial destination or overwrite an existing file. Use
    // cf's Node runtime to link the exact path: ln can link inside a directory created mid-download.
    script = `target=${quote(macPath)}
if [ -e "$target" ] || [ -L "$target" ]; then echo 'Destination already exists' >&2; exit 1; fi
stage=$(/usr/bin/mktemp -d ${quote(posix.dirname(macPath) + '/.hive-transfer.XXXXXX')})
trap '/bin/rm -f "$stage/file"; /bin/rmdir "$stage"' EXIT
cf r2 objects get ${quote(key)} --bucket-name ${quote(BUCKET)} > "$stage/file"
node -e 'require("node:fs").linkSync(process.argv[1], process.argv[2])' "$stage/file" "$target"`;
    await put(vmPath, key);
  }
  // A lost reply does not mean the copy failed. Keep its key so the agent can inspect what
  // finished before trying again; only the VM upload is known to have completed at this point.
  const recovery = `The VM file was uploaded to cloud key ${key}. Inspect the Mac destination ${macPath} before retrying.`;
  let result;
  try {
    result = await run(script);
  } catch (error) {
    throw new Error(`The Mac's transfer result was not received: ${error.message}. ${recovery}`);
  }
  if (result.isError) return { ...result, content: [...result.content, { type: 'text', text: recovery }] };
  return { content: [{ type: 'text', text: JSON.stringify({ key, mac_path: macPath, vm_path: vmPath }) }] };
}
