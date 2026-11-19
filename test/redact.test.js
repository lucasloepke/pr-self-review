const test = require('node:test')
const assert = require('node:assert/strict')
const { redact, scan } = require('../skills/self-review/scripts/redact.js')

const masked = (input, kind) => {
  const r = redact(input)
  assert.ok(r.total > 0, `expected a hit in: ${input}`)
  if (kind) assert.ok(r.kinds[kind], `expected kind ${kind}, got ${JSON.stringify(r.kinds)}`)
  return r.text
}
const untouched = input => assert.equal(redact(input).text, input)

test('token shapes are masked', () => {
  // Built at runtime so the repo itself carries no token-shaped strings.
  const gh = 'ghp_' + 'a1B2c3D4'.repeat(5)
  const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP'
  const stripe = 'sk_' + 'live_' + 'x9'.repeat(12)
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'abcdefghij1234567890'
  assert.equal(masked(`token ${gh} end`, 'github-token'), 'token [REDACTED:github-token] end')
  assert.equal(masked(aws, 'aws-key'), '[REDACTED:aws-key]')
  assert.equal(masked(stripe, 'stripe-key'), '[REDACTED:stripe-key]')
  assert.equal(masked(jwt, 'jwt'), '[REDACTED:jwt]')
  assert.match(masked('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'private-key'), /^\[REDACTED:private-key\]$/)
})

test('headers, cookies, URL credentials and secret assignments keep their label', () => {
  assert.equal(masked('Authorization: Bearer abc.def-123'), 'Authorization: [REDACTED:auth-header]')
  assert.equal(masked('Set-Cookie: sid=abc123; HttpOnly'), 'Set-Cookie: [REDACTED:cookie]')
  assert.equal(masked('postgres://admin:hunter22@db.local/x'), 'postgres://[REDACTED:url-credentials]@db.local/x')
  assert.equal(masked('API_KEY=abcd1234efgh'), 'API_KEY=[REDACTED:secret]')
  assert.equal(masked('password: "correct-horse"'), 'password: "[REDACTED:secret]"')
})

test('ordinary code that mentions secrets is left alone', () => {
  untouched('const password = req.body.password')
  untouched('token = getToken()')
  untouched('if (!apiKey) throw new Error("missing")')
})

test('emails and home paths are personal data; placeholders are not', () => {
  assert.equal(masked('mail jane.doe@acme.io now', 'email'), 'mail [REDACTED:email] now')
  untouched('noreply@anthropic.com and dev@example.com')
  assert.equal(masked('at /Users/jane/work/app.js:3', 'home-path'), 'at ~/work/app.js:3')
  assert.equal(masked('at /home/ci-runner/x', 'home-path'), 'at ~/x')
})

test('masking keeps JSON valid', () => {
  const json = JSON.stringify({ a: 'Authorization: Bearer abc123xyz', b: 'see /Users/jane/x', c: 'jane@acme.io' })
  const out = redact(json).text
  assert.deepEqual(JSON.parse(out), { a: 'Authorization: [REDACTED:auth-header]', b: 'see ~/x', c: '[REDACTED:email]' })
})

test('scan-diff looks only at added lines', () => {
  const diff = '+++ b/x.env\n-OLD_TOKEN=abcd1234efgh\n+NEW_TOKEN=zzzz9999yyyy\n context jane@acme.io'
  const hits = scan(diff, { addedOnly: true })
  assert.deepEqual(hits.map(h => h.line), [3])
  assert.match(hits[0].masked, /REDACTED:secret/)
})
