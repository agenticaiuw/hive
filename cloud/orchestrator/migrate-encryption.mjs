// Encrypt legacy plaintext instruction events without deleting the original.
// All participating writers must use TaskLedger's shared lock.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TaskLedger } from './task-ledger.mjs';
import { defaultLedgerPath } from './local-agent-ledger.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const syncFile = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
const syncDir = path => { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
export function migrateEncryption({ ledgerPath, apply = false, beforeReplace = () => {} }) {
  const ledger = new TaskLedger(ledgerPath);
  return ledger.locked(() => {
    const before = ledger.read();
    const legacy = before.events.filter(e => e.type === 'instruction' && typeof e.text === 'string');
    if (!legacy.length) return { migrated: 0, applied: false, backup: null };
    // Reject suspicious legacy content rather than silently changing user data.
    if (legacy.some(e => /(?:\b(?:password|passwd|passcode|verification\s+code|one.time\s+code|api[ _-]?key|access[ _-]?token|bearer|client[ _-]?secret)\b\s*(?:is\b|[:=])|\b(?:sk-[A-Za-z0-9_-]{12,}|pdt_[A-Za-z0-9_.-]{12,}|ghp_[A-Za-z0-9]{20,})\b)/i.test(e.text))) throw new Error('Legacy content may contain a credential; review required');
    if (!apply) return { migrated: legacy.length, applied: false, backup: null };
    const original = readFileSync(ledger.path);
    let prev = null;
    const events = before.events.map(event => {
      const { hash: _oldHash, ...content } = event;
      content.prev = prev;
      if (content.type === 'instruction' && typeof content.text === 'string') content.text = ledger.encodeText(content.text);
      const next = { ...content, hash: hash(content) }; prev = next.hash; return next;
    });
    const temp = `${ledger.path}.${randomUUID()}.tmp`;
    const backup = `${ledger.path}.${randomUUID()}.plaintext-backup`;
    try {
      writeFileSync(temp, events.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600, flag: 'wx' }); syncFile(temp);
      const candidate = new TaskLedger(temp); candidate.keyPath = ledger.keyPath;
      const after = candidate.read();
      if (JSON.stringify(after.tasks) !== JSON.stringify(before.tasks) || after.stopped !== before.stopped || after.events.length !== before.events.length) throw new Error('Migration verification failed');
      writeFileSync(backup, original, { mode: 0o600, flag: 'wx' }); syncFile(backup); syncDir(backup);
      beforeReplace();
      renameSync(temp, ledger.path); syncDir(ledger.path);
      return { migrated: legacy.length, applied: true, backup };
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== '--apply')) { console.error('Usage: node orchestrator/migrate-encryption.mjs [--apply]'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(migrateEncryption({ ledgerPath: defaultLedgerPath(), apply: args[0] === '--apply' }), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
