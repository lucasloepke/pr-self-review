const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { main } = require('../skills/preflight/scripts/suppressions.js')

test('add writes a commented YAML file; list returns pattern and reason; duplicates are refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-sup-'))
  assert.deepEqual(main(['list', '--repo', repo]), [])
  const a = main(['add', '--repo', repo, '--pattern', 'console.log in scripts/', '--reason', 'CLI tools print by design', '--by', 'tester'])
  assert.equal(a.added, true)
  const text = fs.readFileSync(path.join(repo, '.preflight/suppressions.yml'), 'utf8')
  assert.match(text, /^# Learned suppressions/)
  assert.match(text, /by: "tester"/)
  assert.equal(main(['add', '--repo', repo, '--pattern', 'Console.log in scripts/', '--reason', 'x', '--by', 't']).added, false)
  main(['add', '--repo', repo, '--pattern', 'Missing JSDoc on internal helpers', '--reason', 'team style', '--by', 'tester'])
  assert.deepEqual(main(['list', '--repo', repo]), [
    { pattern: 'console.log in scripts/', reason: 'CLI tools print by design' },
    { pattern: 'Missing JSDoc on internal helpers', reason: 'team style' }
  ])
})

test('add needs a pattern and a reason', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-sup-'))
  assert.throws(() => main(['add', '--repo', repo, '--pattern', 'x']), /--reason/)
})
