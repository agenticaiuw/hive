import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifySensitivity,
  maskSecretValue,
  stripImageBytes,
  SECRET_PLACEHOLDER,
} from './redaction.js'

/*
 * Every credential below is synthetic. Nothing in this file is a real key, and
 * nothing in this file should ever be replaced with one: a test fixture is a
 * file that gets committed, greped, and pasted into bug reports.
 */
const FAKE_STRIPE = 'sk-live-000000000000000000zz'
const FAKE_GITHUB = 'ghp_0000000000000000000000zz'
const FAKE_SLACK = 'xoxb-0000000000-0000000000-zz'

/* ------------------------------------------------------------ the core bug */

test('a secret spoken in prose is replaced, not appended to', () => {
  /*
   * The reported bug. maskSecretValue split on `:`/`=` and kept everything to
   * the left as the "label" -- so a sentence with no separator became its own
   * label and the marker was appended to it:
   *
   *   "the wifi password is hunter2" -> "the wifi password is hunter2: [withheld]"
   *
   * The value survived in full while the record claimed it was withheld, which
   * is worse than not masking at all: every downstream reader trusts the claim.
   */
  const masked = maskSecretValue('the wifi password is hunter2')

  assert.equal(masked.includes('hunter2'), false, 'the secret must not survive the mask')
  assert.equal(masked, SECRET_PLACEHOLDER)
})

test('a bare token is replaced, not labelled with itself', () => {
  /*
   * The report said the bare-token case worked. It did not: with no separator
   * the token became its own label, so the mask emitted the key in full and
   * hung "[withheld]" off the end of it.
   */
  for (const token of [FAKE_STRIPE, FAKE_GITHUB, FAKE_SLACK]) {
    const masked = maskSecretValue(token)
    assert.equal(masked.includes(token), false, `${token} survived its own mask`)
    assert.equal(masked, SECRET_PLACEHOLDER)
  }
})

test('a spoken numeric code is replaced', () => {
  const masked = maskSecretValue('my bike lock code is 4829')
  assert.equal(masked.includes('4829'), false)
  assert.equal(masked, SECRET_PLACEHOLDER)
})

/* ------------------------------------------------- what masking should keep */

test('a key: value line keeps the name and drops the value', () => {
  assert.equal(maskSecretValue(`api_key: ${FAKE_STRIPE}`), `api_key: ${SECRET_PLACEHOLDER}`)
  assert.equal(maskSecretValue('password: hunter2'), `password: ${SECRET_PLACEHOLDER}`)
  assert.equal(
    maskSecretValue('bike lock code: 4829'),
    `bike lock code: ${SECRET_PLACEHOLDER}`,
  )
})

test('a label that is itself the credential is not kept as a label', () => {
  // Splitting on the first separator put the secret in the label position, so
  // the "label" that got kept was the key itself.
  const masked = maskSecretValue(`${FAKE_STRIPE}=1`)
  assert.equal(masked.includes(FAKE_STRIPE), false)
  assert.equal(masked.includes('sk-live'), false)
  assert.equal(classifySensitivity(masked), 'normal')
})

test('a bare numeric code in the label position is not kept as a label', () => {
  const masked = maskSecretValue('4829: my gate code')
  assert.equal(masked.includes('4829'), false)
  assert.equal(masked, SECRET_PLACEHOLDER)
})

test('a locatable credential is cut out and the sentence around it survives', () => {
  const masked = maskSecretValue(`Deploy failed, the CI token ${FAKE_SLACK} expired on Tuesday`)

  assert.equal(masked.includes(FAKE_SLACK), false)
  assert.match(masked, /Deploy failed/)
  assert.match(masked, /expired on Tuesday/)
})

test('every occurrence goes, not just the first', () => {
  const text = `old ${FAKE_STRIPE} and new ${FAKE_GITHUB} and again ${FAKE_STRIPE}`
  const masked = maskSecretValue(text)

  assert.equal(masked.includes(FAKE_STRIPE), false, 'a repeat of the first secret survived')
  assert.equal(masked.includes(FAKE_GITHUB), false)
  assert.equal(masked.split(SECRET_PLACEHOLDER).length - 1, 3)
})

test('an announced-but-unlocatable secret withholds the whole segment', () => {
  /*
   * "the code is 4829" announces a secret whose value has no machine-readable
   * shape -- four digits are indistinguishable from a year or a street number.
   * Nothing can be cut out precisely, so nothing is emitted. Withholding the
   * segment is the correct fallback; emitting it with a marker beside it is the
   * bug this file exists to prevent.
   */
  assert.equal(maskSecretValue('the entry code is 8817'), SECRET_PLACEHOLDER)
})

test('a locatable secret next to an announced one still withholds everything', () => {
  const masked = maskSecretValue(`key ${FAKE_STRIPE} and the door code is 4829`)
  assert.equal(masked.includes(FAKE_STRIPE), false)
  assert.equal(masked.includes('4829'), false)
  assert.equal(masked, SECRET_PLACEHOLDER)
})

/* ------------------------------------------- the known-secret (2-arg) form */

test('a known secret is cut out of surrounding prose', () => {
  const masked = maskSecretValue('Log in with hunter2 before noon', 'hunter2')
  assert.equal(masked, `Log in with ${SECRET_PLACEHOLDER} before noon`)
})

test('a known secret is cut out everywhere it appears', () => {
  const masked = maskSecretValue('hunter2 then hunter2 again', 'hunter2')
  assert.equal(masked.includes('hunter2'), false)
  assert.equal(masked, `${SECRET_PLACEHOLDER} then ${SECRET_PLACEHOLDER} again`)
})

test('a secret that is a substring of a longer word does not corrupt that word', () => {
  /*
   * A naive replace-everywhere turns "concatenate" into "con[withheld]enate":
   * unrelated text destroyed, and a reader told a secret was there. The secret
   * is the standalone occurrence, not every byte sequence that spells it.
   */
  const masked = maskSecretValue('the cat sat while we concatenate the catalog', 'cat')

  assert.equal(masked, `the ${SECRET_PLACEHOLDER} sat while we concatenate the catalog`)
  assert.match(masked, /concatenate/)
  assert.match(masked, /catalog/)
})

test('an empty or absent secret masks nothing and invents nothing', () => {
  assert.equal(maskSecretValue('nothing sensitive here', ''), 'nothing sensitive here')
  assert.equal(maskSecretValue('nothing sensitive here', null), 'nothing sensitive here')
})

test('an empty or absent value is withheld rather than echoed', () => {
  assert.equal(maskSecretValue(''), SECRET_PLACEHOLDER)
  assert.equal(maskSecretValue(null), SECRET_PLACEHOLDER)
  assert.equal(maskSecretValue(undefined), SECRET_PLACEHOLDER)
})

test('an absent known secret still refuses to emit a credential it can see', () => {
  // The caller had no needle to hand over; the text carries a key regardless.
  const masked = maskSecretValue(`deploy with ${FAKE_STRIPE}`, '')
  assert.equal(masked.includes(FAKE_STRIPE), false)
  assert.equal(masked, SECRET_PLACEHOLDER)
})

test('a secret made of regex metacharacters is masked literally', () => {
  /*
   * new RegExp(secret) on any of these either throws (unterminated group, bad
   * character class) or silently matches something else -- and a mask that
   * throws and a mask that matches the wrong span are the same leak.
   */
  const metacharacterSecrets = [
    'a.b*c+d?e',
    '(paren)',
    '[bracket]',
    'back\\slash',
    'dollar$sign',
    'a+b(c)[d]*e?f.g$h\\i',
    '^anchor$',
    'pipe|alt',
    'brace{2,3}',
  ]

  for (const secret of metacharacterSecrets) {
    const text = `before ${secret} after`
    let masked
    assert.doesNotThrow(() => {
      masked = maskSecretValue(text, secret)
    }, `masking threw on ${secret}`)

    assert.equal(masked.includes(secret), false, `${secret} survived its own mask`)
    assert.equal(masked, `before ${SECRET_PLACEHOLDER} after`)
  }
})

test('a metacharacter secret does not match a lookalike it should not', () => {
  // `a.c` as a regex matches "abc". As a literal it does not.
  const masked = maskSecretValue('abc and a.c', 'a.c')
  assert.match(masked, /abc/, 'the regex interpretation ate an unrelated word')
  assert.equal(masked, `abc and ${SECRET_PLACEHOLDER}`)
})

/* --------------------------------------------------- classification is kept */

test('classifySensitivity keeps its verdicts', () => {
  assert.equal(classifySensitivity(FAKE_STRIPE), 'secret')
  assert.equal(classifySensitivity(FAKE_GITHUB), 'secret')
  assert.equal(classifySensitivity('AKIA0000000000000000'), 'secret')
  assert.equal(classifySensitivity('the wifi password is hunter2'), 'secret')
  assert.equal(classifySensitivity('my bike lock code is 4829'), 'secret')
  assert.equal(classifySensitivity('-----BEGIN RSA PRIVATE KEY-----'), 'secret')
  assert.equal(classifySensitivity('david@stanford.edu'), 'sensitive')
  assert.equal(classifySensitivity('415 555 0134'), 'sensitive')
  assert.equal(classifySensitivity('the GPU cluster is called SAIL'), 'normal')
  assert.equal(classifySensitivity(''), 'normal')
  assert.equal(classifySensitivity(null), 'normal')
})

test('the mask never returns something that still reads as a secret', () => {
  /*
   * The property that makes the mask trustworthy to every caller, and the one
   * the old callers had to check for themselves: whatever comes back, running
   * the classifier over it must no longer find a credential.
   *
   * Note this is deliberately NOT "no word of the input survives". Keeping
   * "Deploy failed ... expired" is the point of locating the credential rather
   * than withholding the sentence; a caller that treats surviving English as
   * proof of a leak throws away the readable part for nothing.
   */
  const inputs = [
    'the wifi password is hunter2',
    FAKE_STRIPE,
    `Deploy failed, the CI token ${FAKE_SLACK} expired`,
    'my bike lock code is 4829',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBAAAA0000\n-----END RSA PRIVATE KEY-----',
    `${FAKE_STRIPE}=1`,
    'AKIA0000000000000000 is the deploy identity',
  ]

  for (const input of inputs) {
    const masked = maskSecretValue(input)
    assert.notEqual(classifySensitivity(masked), 'secret', `${input} still reads as secret`)
  }
})

test('a kept label still announces a secret, and that is the point', () => {
  /*
   * `api_key: [withheld]` classifies as secret, because the classifier matches
   * the announcement and the announcement is exactly what was deliberately
   * kept. A caller must therefore not use "does the output classify as secret"
   * as a leak check -- the value is gone, the name is not, and keeping the name
   * is the whole reason a fact survives masking rather than vanishing.
   */
  const masked = maskSecretValue(`api_key: ${FAKE_STRIPE}`)

  assert.equal(masked, `api_key: ${SECRET_PLACEHOLDER}`)
  assert.equal(masked.includes(FAKE_STRIPE), false)
  assert.equal(classifySensitivity(masked), 'secret')
})

test('a value the owner marked secret is withheld even if no pattern knows it', () => {
  /*
   * sensitivity can be set by hand at write time, so the classifier's verdict
   * is not the only reason a value gets here. A value that matches nothing must
   * still not come back verbatim: the caller already decided it was a secret.
   */
  assert.equal(maskSecretValue('the spare is under the third flowerpot'), SECRET_PLACEHOLDER)
})

test('the secret itself is gone even when prose around it is kept', () => {
  const secrets = [FAKE_STRIPE, FAKE_GITHUB, FAKE_SLACK, 'hunter2', '4829', 'MIIBAAAA0000']
  const inputs = [
    'the wifi password is hunter2',
    FAKE_STRIPE,
    `api_key: ${FAKE_STRIPE}`,
    `Deploy failed, the CI token ${FAKE_SLACK} expired`,
    'my bike lock code is 4829',
    `push with ${FAKE_GITHUB} nightly`,
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBAAAA0000\n-----END RSA PRIVATE KEY-----',
  ]

  for (const input of inputs) {
    const masked = maskSecretValue(input)
    for (const secret of secrets) {
      if (!input.includes(secret)) continue
      assert.equal(masked.includes(secret), false, `${secret} survived masking of ${input}`)
    }
  }
})

/* --------------------------------------------------------------- unrelated */

test('stripImageBytes drops image payloads at every depth', () => {
  const clean = stripImageBytes({
    ok: true,
    imageBase64: 'AAAA',
    nested: [{ dataUrl: 'data:image/png;base64,AAAA', keep: 1 }],
  })

  assert.deepEqual(clean, { ok: true, nested: [{ keep: 1 }] })
})
