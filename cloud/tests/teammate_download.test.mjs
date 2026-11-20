// The teammate download: tools/carry.mjs fills Hive.app with a Mac release, the voice files, uv and
// Codex; tools/first-open.sh, run from inside the app, fills a Hive folder from them. Stand-ins replace
// uv, Python and Codex, and the Kokoro files are already there, so nothing is downloaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack } from '../vm-agent/version.mjs';
import { carry, lockedPython, uvOffers } from '../../desktop/app/tools/carry.mjs';

const FIRST_OPEN = new URL('../../desktop/app/tools/first-open.sh', import.meta.url).pathname;

function write(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const LOCK = '# The voice packages\n# python: 3.14.7\nnumpy==2.5.4\nsoxr==1.1.0\n';

// A uv that answers the calls carry.mjs and first-open.sh make, and logs them.
const FAKE_UV = `#!/bin/bash
echo "$*" >> "$UV_LOG"
case "$1 $2" in
  "python list") echo "cpython-3.14.7-macos-aarch64-none                      <download available>" ;;
  "python install") mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-3.14.7" ;;
  "venv --quiet")
    dir="\${@: -1}"; mkdir -p "$dir/bin"
    # Its python logs what it runs; the wake-word download leaves its model as the real one does.
    printf '#!/bin/bash\\nif [ "$1" = -c ]; then echo 3.14.7; else echo "ran $*" >> "%s"; case "$1" in */wake.py) d="$(dirname "$1")/../models/wake"; mkdir -p "$d"; : > "$d/tokens.txt" ;; esac; fi\\n' "$UV_LOG" > "$dir/bin/python"
    chmod +x "$dir/bin/python" ;;
  "pip sync") ;;
esac
`;

test('the lock names its Python, and uv must offer it', () => {
  assert.equal(lockedPython(LOCK), '3.14.7');
  assert.throws(() => lockedPython('numpy==1\n'), /names no Python version/);
  assert.ok(uvOffers('cpython-3.14.7-macos-aarch64-none   <download available>\n', '3.14.7'));
  assert.ok(!uvOffers('cpython-3.14.0-macos-aarch64-none   <download available>\n', '3.14.7'));
  assert.ok(uvOffers('cpython-3.14.7-darwin-aarch64-none   <download available>\n', '3.14.7'));
  assert.ok(!uvOffers('cpython-3.14.70-darwin-aarch64-none   <download available>\n', '3.14.7'));
});

test('carry.mjs puts a release, the voice files, uv and Codex in the app, and first-open.sh sets up a Hive folder from them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-carry-'));
  try {
    const app = join(dir, 'Hive.app');
    write(join(app, 'Contents/Info.plist'), '<plist/>');
    const release = join(dir, 'mac.release');
    writeFileSync(release, pack('mac', [
      { path: 'desktop/app/build/hive-agent', mode: 0o755, data: Buffer.from('#!/bin/sh\necho agent\n') },
      { path: 'desktop/app/build/dashboard/index.html', mode: 0o644, data: Buffer.from('<html>') },
      { path: 'browser/chrome/build/chrome/manifest.json', mode: 0o644, data: Buffer.from('{}') },
    ], { version: 'abc123def456', arch: 'arm64' }).bytes);
    const source = join(dir, 'export');
    write(join(source, 'desktop/app/python/listen.py'), 'print("listen")\n');
    write(join(source, 'desktop/app/python/voiceprint.py'), 'print("voiceprint")\n');
    write(join(source, 'desktop/app/python/__pycache__/listen.cpython-314.pyc'), 'cache');
    write(join(source, 'desktop/app/requirements.lock'), LOCK);
    write(join(source, 'cloud/knowledge/migrations/0001_init.sql'), 'create table x(y);\n');
    write(join(source, 'desktop/app/tools/first-open.sh'), readFileSync(FIRST_OPEN), 0o755);
    const uv = join(dir, 'tools/uv');
    write(uv, FAKE_UV, 0o755);
    const codex = join(dir, 'codex-native');
    write(join(codex, 'bin/codex'), '#!/bin/sh\n[ "$1 $2" = "login status" ] && exit 0\necho codex "$@"\n', 0o755);
    write(join(codex, 'codex-path/rg'), '#!/bin/sh\n', 0o755);

    const log = join(dir, 'uv.log');
    process.env.UV_LOG = log;
    const done = carry({ app, release, source, uv, codex });
    assert.deepEqual([done.version, done.python], ['abc123def456', '3.14.7']);
    const carried = join(app, 'Contents/Resources/hive');
    for (const path of ['desktop/app/build/hive-agent', 'desktop/app/build/dashboard/index.html', 'browser/chrome/build/chrome/manifest.json',
      'desktop/app/python/listen.py', 'desktop/app/requirements.lock', 'cloud/knowledge/migrations/0001_init.sql', 'first-open.sh']) {
      assert.ok(existsSync(join(carried, path)), path);
    }
    assert.ok(!existsSync(join(carried, 'desktop/app/python/__pycache__')), 'no Python caches');
    assert.match(readFileSync(join(carried, 'VERSION'), 'utf8'), /^abc123def456 [0-9a-f]{12}\n$/);
    assert.ok(existsSync(join(app, 'Contents/Helpers/uv')));
    assert.ok(existsSync(join(app, 'Contents/Helpers/codex/codex-path/rg')));

    // First open: the Kokoro files are there already, so nothing is fetched.
    const root = join(dir, 'Application Support/Hive/install');
    for (const f of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) write(join(root, 'desktop/app/models', f), 'model');
    const run = () => execFileSync('/bin/bash', [join(carried, 'first-open.sh'), root], { encoding: 'utf8', env: { ...process.env, UV_LOG: log } });
    const first = run();
    assert.match(first, /step: Putting Hive's agent and tools in place\n/);
    assert.match(first, /step: Getting Python 3\.14\.7\n/);
    assert.match(first, /step: Installing the voice packages \(2 of them/);
    assert.match(first, /step: Downloading what hears you/);
    assert.match(first, /step: Downloading what hears "hive" and "bye"/);
    assert.match(first, /\nready\n$/);
    assert.ok(existsSync(join(root, 'desktop/app/build/hive-agent')));
    assert.ok(existsSync(join(root, 'cloud/knowledge/migrations/0001_init.sql')));
    assert.equal(readlinkSync(join(root, 'bin/codex')), join(app, 'Contents/Helpers/codex/bin/codex'));
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /python install --quiet --no-bin 3\.14\.7/);
    assert.match(calls, /pip sync --quiet --python .*\.venv\/bin\/python .*requirements\.lock/);
    assert.match(calls, /ran .*python\/listen\.py --download/);
    assert.match(calls, /ran .*python\/voiceprint\.py --download/);
    assert.match(calls, /ran .*python\/wake\.py --download/);

    // Opening again only checks.
    assert.equal(run(), 'ready\n');

    // A newer app replaces what it carries; the voice stays.
    writeFileSync(join(carried, 'VERSION'), 'fff000fff000 000000000000\n');
    assert.equal(run(), "step: Putting Hive's agent and tools in place\nready\n");
  } finally {
    delete process.env.UV_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});
