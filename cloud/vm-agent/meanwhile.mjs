// What's said to a request while Hive's agents on the VM work on it: the owner typing into a working
// Hive's message box, which the board makes a follow-up request (cloud/tasks/worker.js followUp). The
// owner, 2026-11-21: "why is it when i inserted a message it did not reach hive?" The follow-up used to
// wait until the request it follows ended, which can be an hour when Hive changes itself on the way.
//
// Now the orchestrator leaves the words in the state folder's inbox for that request (leave), and each
// of the request's tasks hears them once (hear): with the next answer from any of its tool servers
// (withHeard), or in its brief when it starts or starts again after Hive changed itself. Who heard what
// is one file per task, <id>.heard-<label>, made with O_EXCL so only one of a task's tool servers adds
// it. The orchestrator closes the follow-up once a task heard it (heardBy), and runs it as a request of
// its own after the one it follows only if none did; either way it then takes the words back (forget).
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A task's label on the VM (orchestrator.mjs labelOf): R<request>-<task>. */
const LABEL = /^R(\d+)-(\d+)$/;
const SAID = /^(\d+)\.json$/;

export const inboxOf = (stateDir, request) => join(stateDir, 'inbox', `r${Number(request)}`);

/** Leaves follow-up `id`'s words for request `request`'s tasks. */
export function leave(stateDir, request, { id, text, from = 'The owner' }) {
  const dir = inboxOf(stateDir, request);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${Number(id)}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ id: Number(id), text: String(text ?? ''), from }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** What task `label` hasn't heard yet, oldest first, each marked heard by it as it's handed over. */
export function hear(stateDir, label) {
  const found = LABEL.exec(label ?? '');
  if (!found || !stateDir) return [];
  const dir = inboxOf(stateDir, found[1]);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const heard = [];
  for (const name of names.filter(n => SAID.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    let said;
    try {
      said = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue; // taken back meanwhile
    }
    try {
      closeSync(openSync(join(dir, `${parseInt(name, 10)}.heard-${label}`), 'wx'));
    } catch {
      continue; // this task heard it already, through another of its tool servers
    }
    heard.push(said);
  }
  return heard;
}

/** The tasks that heard follow-up `id`. */
export function heardBy(stateDir, request, id) {
  const start = `${Number(id)}.heard-`;
  try {
    return readdirSync(inboxOf(stateDir, request)).filter(n => n.startsWith(start)).map(n => n.slice(start.length));
  } catch {
    return [];
  }
}

/** Takes follow-up `id`'s words back, so no task hears them after this. */
export function forget(stateDir, request, id) {
  const dir = inboxOf(stateDir, request);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === `${Number(id)}.json` || name.startsWith(`${Number(id)}.heard-`)) rmSync(join(dir, name), { force: true });
  }
  try {
    rmdirSync(dir); // only once nothing else is left in it
  } catch {}
}

/** The words a task hears, as one part of what it reads ('' for none). */
export function told(heard) {
  if (!heard?.length) return '';
  return [
    ...heard.map(s => `${s.from || 'The owner'} just said this about the request you're working on, word for word, through Hive's message box: «${s.text}»`),
    'Take it into account from here on: if it changes what you should do, change course now.',
  ].join('\n');
}

/** A tool server's answer to `tools/call`, with what its task hasn't heard yet added at the end. */
export function withHeard(out, stateDir = process.env.HIVE_VM_STATE, label = process.env.HIVE_TASK_LABEL) {
  if (!Array.isArray(out?.result?.content)) return out;
  const news = told(hear(stateDir, label));
  if (!news) return out;
  return { ...out, result: { ...out.result, content: [...out.result.content, { type: 'text', text: news }] } };
}
