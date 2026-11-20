// Hive Phone (mobile/relay) as the board offers it: its release versions, what they're built from, and
// the phone's own pairing code (PhoneRelay.h) reading exactly what the board's "Connect an iPhone"
// copies. That last one compiles PhoneRelay.h for Mac Catalyst, which has UIKit, so it runs here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHONE_SOURCES, phoneVersion, sourceFiles } from '../release.mjs'
import { BUNDLE_ID as BUILT_ID, bundleVersions } from '../../mobile/relay/build.mjs'
import { BUNDLE_ID, PAIRING_PREFIX, appVersion, phoneKey } from '../tasks/phone.js'
import { bundleVersion } from '../vm-agent/version.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const RELAY_H = path.join(REPO, 'mobile/relay/WebDriverAgent/WebDriverAgentRunner/PhoneRelay.h')

test('a release version is what SideStore compares first, then the sources, and the board takes it', () => {
  const at = new Date(Date.UTC(2026, 0, 5, 9, 7))
  const version = phoneVersion('3f2a9b8c7d6e', at)
  assert.equal(version, '2026.0105.0907-3f2a9b8c7d6e')
  assert.match(version, /^[a-z0-9][a-z0-9.-]{3,39}$/, "the board's release version rule")
  assert.deepEqual(appVersion(version), { version: '2026.0105.0907', build: '2026.0105.0907' })
  const v = bundleVersions(version)
  assert.deepEqual([v.short, v.build, v.full], ['2026.0105.0907', '2026.0105.0907', version], 'the IPA says what the source says')
  // Each later build compares as newer, part by part, the way SideStore compares versions.
  const parts = (s) => s.split('-')[0].split('.').map(Number)
  const later = [phoneVersion('a', new Date(Date.UTC(2026, 0, 5, 23, 59))), phoneVersion('b', new Date(Date.UTC(2026, 10, 18, 0, 1))), phoneVersion('c', new Date(Date.UTC(2027, 0, 1, 0, 0)))]
  let last = parts(version)
  for (const next of later.map(parts)) {
    const i = next.findIndex((n, k) => n !== last[k])
    assert.ok(i >= 0 && next[i] > last[i], `${next} after ${last}`)
    last = next
  }
  assert.deepEqual([bundleVersions('dev').short, bundleVersions('dev').build], ['0.0.0', '0'])
})

test("the version's hash is the relay's sources, never its build output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-release-'))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  write('mobile/relay/WebDriverAgent/WebDriverAgentRunner/PhoneRelay.h', '// relay')
  write('mobile/relay/build.mjs', '// build')
  write('mobile/relay/icon/AppIcon60x60@2x.png', 'png')
  const before = bundleVersion(sourceFiles(root, PHONE_SOURCES))
  write('mobile/relay/build/HivePhone.ipa', 'zip')
  write('mobile/relay/WebDriverAgent/build/x.o', 'obj')
  assert.equal(bundleVersion(sourceFiles(root, PHONE_SOURCES)), before)
  write('mobile/relay/WebDriverAgent/WebDriverAgentRunner/PhoneRelay.h', '// relay, changed')
  assert.notEqual(bundleVersion(sourceFiles(root, PHONE_SOURCES)), before)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the app, its build and the board agree on its id and its pairing', () => {
  assert.equal(BUILT_ID, BUNDLE_ID)
  const relay = fs.readFileSync(RELAY_H, 'utf8')
  assert.match(relay, new RegExp(`HivePairingPrefix = @"${PAIRING_PREFIX}"`))
  assert.match(relay, /forHTTPHeaderField:@"X-Hive-Node"/)
  assert.match(relay, /@"phone:iphone"/, 'the board notes the phone as phone:iphone')
  for (const size of ['2x', '3x']) assert.ok(fs.existsSync(path.join(REPO, `mobile/relay/icon/AppIcon60x60@${size}.png`)))
})

const canCompile = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'clang'], { stdio: 'ignore' }).status === 0

test("the phone reads the board's pairing, and nothing else", { skip: !canCompile && 'needs Xcode on a Mac' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-pairing-'))
  try {
    fs.writeFileSync(path.join(dir, 'main.m'), `#import "PhoneRelay.h"
int main(int argc, const char **argv) {
  @autoreleasepool {
    for (int i = 1; i < argc; i++) {
      NSDictionary *p = [PhoneRelay pairingFrom:[NSString stringWithUTF8String:argv[i]]];
      NSData *d = p ? [NSJSONSerialization dataWithJSONObject:p options:NSJSONWritingSortedKeys error:nil] : nil;
      printf("%s\\n", d ? [[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] UTF8String] : "null");
    }
  }
  return 0;
}
`)
    const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    const ios = path.join(sdk, 'System/iOSSupport/System/Library/Frameworks')
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-target', 'arm64-apple-ios17.0-macabi', '-isysroot', sdk, '-iframework', ios, '-F', ios,
      '-I', path.dirname(RELAY_H), '-framework', 'Foundation', '-framework', 'UIKit', path.join(dir, 'main.m'), '-o', path.join(dir, 'pairing')], { stdio: 'pipe' })

    const token = await phoneKey({ TASKS_TOKEN: 'board-secret' })
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const url = 'wss://board.test/v1/phone/device'
    const cases = [
      [`${PAIRING_PREFIX}${b64({ url, token })}`, { token, url }],
      [`  ${PAIRING_PREFIX}${b64({ url, token })}\n`, { token, url }],
      [`${PAIRING_PREFIX}${b64({ url: 'wss://relay.example/device', token })}`, { token, url: 'wss://relay.example/device' }],
      [`${PAIRING_PREFIX}${b64({ url: 'ws://board.test/v1/phone/device', token })}`, null],
      [`${PAIRING_PREFIX}${b64({ url: 'wss://board.test/v1/phone/api', token })}`, null],
      [`${PAIRING_PREFIX}${b64({ url, token: 'short' })}`, null],
      [`${PAIRING_PREFIX}${b64([url, token])}`, null],
      [`${PAIRING_PREFIX}not base64 at all`, null],
      [`${b64({ url, token })}`, null],
      ['https://example.com', null],
    ]
    const said = execFileSync(path.join(dir, 'pairing'), cases.map(([text]) => text), { encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(said.map((line) => JSON.parse(line)), cases.map(([, want]) => want))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
