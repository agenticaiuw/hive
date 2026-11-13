#!/usr/bin/env node
// The VM's saved logins: Hive's equivalent of the Mac's Keychain, kept by the Linux system rather
// than a browser. The logins are one JSON document encrypted with `systemd-creds` under the VM's
// own machine key (/var/lib/systemd/credential.secret), in a folder only root can open, so this
// runs as root (the `hive-cred` command wraps it in sudo). Nothing here prints a password.
//
//   hive-cred list                       sites and usernames
//   hive-cred sites                      sites only
//   hive-cred add <url> [username]       asks for the password without echoing it
//   hive-cred remove <url> [username]
//   hive-cred import < passwords.csv     a Passwords (Mac) or Chrome export; merges by site+username
//   hive-cred secret <url> [username]    for Hive's authenticate tool: one login as JSON on stdout,
//                                        only when stdout is not a terminal
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.HIVE_CRED_DIR ?? '/var/lib/hive-credentials';
const STORE = join(DIR, 'store.cred');
const NAME = 'hive-logins';

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.some(value => value !== '')) rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); if (row.some(value => value !== '')) rows.push(row);
  return rows;
}

/** Logins from a Passwords (Title,URL,Username,Password,Notes,OTPAuth) or Chrome (name,url,username,password,note) export. */
export function loginsFromCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  if (!header) return [];
  const column = names => header.findIndex(name => names.includes(name.trim().toLowerCase()));
  const at = { title: column(['title', 'name']), url: column(['url', 'website', 'login_uri']), username: column(['username', 'login_username']),
    password: column(['password', 'login_password']), otp: column(['otpauth', 'totp', 'login_totp']) };
  if (at.url < 0 || at.password < 0) throw new Error('the file has no URL and Password columns; export it from Passwords or Chrome');
  return rows.map(row => tidy({
    title: at.title >= 0 ? row[at.title] ?? '' : '', url: row[at.url] ?? '', username: at.username >= 0 ? row[at.username] ?? '' : '',
    password: row[at.password] ?? '', ...(at.otp >= 0 && row[at.otp] ? { otp: row[at.otp] } : {}),
  })).filter(login => login.url && login.password);
}

/** Spaces and tabs around a site or username are typos ("name\t" is the same login); a password is kept as it is. */
export const tidy = login => ({ ...login, url: String(login.url ?? '').trim(), username: String(login.username ?? '').trim() });

/** "https://login.wisc.edu/idp/..." or "login.wisc.edu" → "login.wisc.edu". */
export function hostOf(url) {
  const text = String(url).trim();
  try { return new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return text.toLowerCase(); }
}

/** The saved logins for a site: the same host first, then a parent or child domain (wisc.edu ↔ login.wisc.edu). */
export function matching(logins, site, username) {
  const host = hostOf(site);
  const related = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  const found = logins.filter(login => related(hostOf(login.url), host) && (!username || login.username === username));
  return found.sort((a, b) => Number(hostOf(b.url) === host) - Number(hostOf(a.url) === host));
}

/** The one login to use for a site, or {choices} when it isn't clear which. */
export function pick(logins, site, username) {
  const found = matching(logins, site, username);
  const exact = found.filter(login => hostOf(login.url) === hostOf(site));
  if (exact.length === 1) return exact[0];
  if (!exact.length && found.length === 1) return found[0];
  return { choices: found.map(login => ({ site: hostOf(login.url), username: login.username })) };
}

export function merge(logins, incoming) {
  const key = login => `${hostOf(login.url)}\u0000${login.username}`;
  const byKey = new Map(logins.map(login => [key(login), login]));
  let added = 0; let updated = 0;
  for (const login of incoming) {
    const existing = byKey.get(key(login));
    if (!existing) added++; else if (existing.password !== login.password || existing.otp !== login.otp) updated++;
    byKey.set(key(login), { ...existing, ...login });
  }
  return { logins: [...byKey.values()], added, updated };
}

function load() {
  if (!existsSync(STORE)) return [];
  const saved = JSON.parse(execFileSync('systemd-creds', ['decrypt', `--name=${NAME}`, STORE, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));
  return merge([], saved.map(tidy)).logins;
}

function save(logins) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const part = `${STORE}.part`;
  execFileSync('systemd-creds', ['encrypt', `--name=${NAME}`, '-', part], { input: JSON.stringify(logins), maxBuffer: 64 * 1024 * 1024 });
  renameSync(part, STORE); chmodSync(STORE, 0o600);
}

const readStdin = () => readFileSync(0, 'utf8');

function askHidden(prompt) {
  process.stderr.write(prompt);
  execFileSync('stty', ['-echo'], { stdio: 'inherit' });
  try { return readFileSync('/dev/tty', 'utf8').split('\n')[0]; } finally { execFileSync('stty', ['echo'], { stdio: 'inherit' }); process.stderr.write('\n'); }
}

function main([command, ...args]) {
  if (process.getuid() !== 0) { console.error('hive-cred runs as root; use the hive-cred command (it uses sudo)'); process.exit(2); }
  if (command === 'list' || command === 'sites') {
    const logins = load().sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)));
    if (command === 'sites') { const hosts = [...new Set(logins.map(login => hostOf(login.url)))]; console.log(hosts.join('\n')); console.error(`${hosts.length} sites, ${logins.length} logins`); return; }
    for (const login of logins) console.log(`${hostOf(login.url)}\t${login.username}`);
    console.error(`${logins.length} logins`);
  } else if (command === 'import') {
    const incoming = loginsFromCsv(readStdin());
    const { logins, added, updated } = merge(load(), incoming);
    save(logins);
    console.log(`Imported ${incoming.length} logins: ${added} new, ${updated} changed, ${logins.length} saved in all.`);
  } else if (command === 'add') {
    const [url, username = ''] = args;
    if (!url) throw new Error('usage: hive-cred add <url> [username]');
    const password = askHidden(`Password for ${username || '(no username)'} at ${hostOf(url)}: `);
    if (!password) throw new Error('no password given');
    const { logins } = merge(load(), [{ title: hostOf(url), url, username, password }]);
    save(logins); console.log(`Saved the login for ${hostOf(url)}.`);
  } else if (command === 'remove') {
    const [url, username] = args;
    const logins = load(); const gone = new Set(matching(logins, url, username).filter(login => hostOf(login.url) === hostOf(url)));
    save(logins.filter(login => !gone.has(login))); console.log(`Removed ${gone.size} login${gone.size === 1 ? '' : 's'}.`);
  } else if (command === 'secret') {
    if (process.stdout.isTTY) { console.error('secret only answers a program, never a terminal'); process.exit(2); }
    const [site, username] = args;
    const login = pick(load(), site, username);
    process.stdout.write(JSON.stringify(login.choices ? login : { login: { site: hostOf(login.url), username: login.username, password: login.password } }));
  } else {
    console.error('usage: hive-cred list | sites | add <url> [username] | remove <url> [username] | import < export.csv');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`hive-cred: ${error.message.split('\n')[0]}`); process.exit(1); }
}
