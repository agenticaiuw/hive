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
    + 'Sources and the cloud copy are kept. Uses the Mac\'s cf login; does not send or publish to anyone else.',
  inputSchema: { type: 'object', properties: {
    direction: { type: 'string', enum: ['to_vm', 'to_mac'] },
    mac_path: { type: 'string' }, vm_path: { type: 'string', description: 'Required for to_mac' },
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

export async function transferFile(args, command, { fetch = fetchFile, put = putFile, uuid = randomUUID } = {}) {
  const { direction, mac_path: macPath, vm_path: vmPath, step } = args;
  if (!['to_vm', 'to_mac'].includes(direction)) throw new Error('direction must be to_vm or to_mac');
  if (!filePath(macPath) || (direction === 'to_mac' && !filePath(vmPath))) throw new Error('Give absolute file paths');
  if (typeof step !== 'string' || !step.trim()) throw new Error('Say what file you are copying in step');
  const key = checkKey(`transfers/${uuid()}/${posix.basename(direction === 'to_vm' ? macPath : vmPath)}`);
  let script;
  if (direction === 'to_vm') {
    script = `test -f ${quote(macPath)} || exit 1\ncf r2 objects put ${quote(key)} --bucket-name ${quote(BUCKET)} --file ${quote(macPath)} --content-type ${quote(contentType(macPath))}`;
  } else {
    // Check the destination before downloading. Link a completed temporary file into place so a
    // failed download cannot leave a partial destination or overwrite an existing file.
    script = `target=${quote(macPath)}
if [ -e "$target" ] || [ -L "$target" ]; then echo 'Destination already exists' >&2; exit 1; fi
stage=$(/usr/bin/mktemp -d ${quote(posix.dirname(macPath) + '/.hive-transfer.XXXXXX')})
trap '/bin/rm -f "$stage/file"; /bin/rmdir "$stage"' EXIT
cf r2 objects get ${quote(key)} --bucket-name ${quote(BUCKET)} > "$stage/file"
/bin/ln -n "$stage/file" "$target"`;
    await put(vmPath, key);
  }
  const result = await command({ command: `set -e\numask 077\n${CF}${script}`, irreversible: false, step, timeout_seconds: 240 });
  if (result.isError) return result;
  let local = vmPath;
  if (direction === 'to_vm') {
    try { local = await fetch(key); }
    catch (error) { throw new Error(`Copied to cloud key ${key}, but the VM could not fetch it: ${error.message}`); }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ key, mac_path: macPath, vm_path: local }) }] };
}
