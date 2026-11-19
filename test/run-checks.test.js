// run-checks.js against throwaway repos using node:test as the project's suite.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { main, parseFailures } = require('../skills/self-review/scripts/run-checks.js')

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psr-chk-')))

function repo(files) {
  const dir = tmp()
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim()
  const write = fs2 => { for (const [f, s] of Object.entries(fs2)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s) } }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  write(files); git('add', '-A'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  return { dir, base, git, commit: (f, msg = 'head') => { write(f); git('add', '-A'); git('commit', '-qm', msg) } }
}

const T = (name, body) => `test(${JSON.stringify(name)}, () => { ${body} })\n`
const HEAD = "const test = require('node:test'); const assert = require('node:assert/strict'); const m = require('../m.js')\n"
const CMD = 'node --test test/'

test('parseFailures reads TAP, spec, jest, pytest and go output; strips roots', () => {
  assert.deepEqual(parseFailures('ok 1 - a\nnot ok 2 - b\nnot ok 3 - c # TODO later\n', []), ['b'])
  assert.deepEqual(parseFailures('✖ adds up (1.2ms)\n', []), ['adds up'])
  assert.deepEqual(parseFailures('  ✕ renders (12 ms)\n', []), ['renders'])
  assert.deepEqual(parseFailures('FAILED tests/test_x.py::test_y - assert\n', []), ['tests/test_x.py::test_y'])
  assert.deepEqual(parseFailures('--- FAIL: TestThing (0.00s)\n', []), ['TestThing'])
  assert.deepEqual(parseFailures('not ok 1 - /r/oot/test/a.test.js\n', ['/r/oot']), ['test/a.test.js'])
  assert.equal(parseFailures('Error: something broke\n', []), null)
})

test('a test the PR breaks is a regression; one already failing on base is pre-existing', () => {
  const r = repo({
    'm.js': 'module.exports = { add: (a, b) => a + b, sub: (a, b) => a + b }\n',
    'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(2, 2), 4)') + T('sub', 'assert.equal(m.sub(3, 1), 2)')
  })
  r.commit({ 'm.js': 'module.exports = { add: (a, b) => a - b, sub: (a, b) => a + b }\n' })
  const out = main(['--repo', r.dir, '--out', path.join(tmp(), 'o'), '--cmd', CMD, '--base', r.base, '--reruns', '1'])
  const c = out.commands[0]
  assert.equal(c.result, 'Fail')
  assert.deepEqual(c.regressions, ['add'])
  assert.deepEqual(c.preExisting, ['sub'])
  assert.equal(c.head.runs, 2)
  assert.equal(out.rows.tests.result, 'Fail')
  assert.equal(out.rows.regression.result, 'Fail')
  assert.match(out.rows.regression.notes, /add/)
  assert.deepEqual(r.git('worktree', 'list').split('\n').length, 1)
})

test('failures that are all pre-existing do not fail the PR', () => {
  const r = repo({ 'm.js': 'module.exports = { add: (a, b) => a - b }\n', 'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(2, 2), 4)') })
  r.commit({ 'README.md': 'docs\n' })
  const out = main(['--repo', r.dir, '--out', path.join(tmp(), 'o'), '--cmd', CMD, '--base', r.base, '--reruns', '0'])
  assert.equal(out.commands[0].result, 'Pre-existing')
  assert.equal(out.rows.tests.result, 'Pass')
  assert.match(out.rows.tests.notes, /pre-existing/)
  assert.equal(out.rows.regression.result, 'Pass')
})

test('a test that fails once and then passes is flaky', () => {
  const state = path.join(tmp(), 'count')
  const r = repo({
    'm.js': 'module.exports = {}\n',
    'test/m.test.js': `const test = require('node:test'); const fs = require('node:fs')
${T('steady', '')}${T('wobbly', `const n = fs.existsSync(${JSON.stringify(state)}) ? 1 : 0; fs.writeFileSync(${JSON.stringify(state)}, 'x'); if (!n) throw new Error('first run fails')`)}`
  })
  const out = main(['--repo', r.dir, '--out', path.join(tmp(), 'o'), '--cmd', CMD, '--base', r.base])
  assert.equal(out.commands[0].result, 'Flaky')
  assert.deepEqual(out.commands[0].flaky, ['wobbly'])
  assert.equal(out.rows.tests.result, 'Pass')
  assert.match(out.rows.tests.notes, /flaky: wobbly/)
})

test('proof: the PR\'s new test fails on the base and passes on the head', () => {
  const r = repo({ 'm.js': 'module.exports = { add: (a, b) => a + b }\n', 'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(1, 1), 2)') })
  r.commit({
    'm.js': 'module.exports = { add: (a, b) => a + b, double: a => a * 2 }\n',
    'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(1, 1), 2)') + T('double', 'assert.equal(m.double(4), 8)')
  })
  const list = path.join(tmp(), 'tests.txt')
  fs.writeFileSync(list, 'test/m.test.js\n')
  const out = main(['--repo', r.dir, '--out', path.join(tmp(), 'o'), '--cmd', CMD, '--base', r.base, '--proof-tests', list])
  assert.equal(out.rows.tests.result, 'Pass')
  assert.equal(out.proof.result, 'Provided')
  assert.deepEqual(out.proof.items.map(i => i.test), ['double'])
  assert.match(out.proofMarkdown, /\| `double` \| ❌ fails \| ✅ passes \|/)
})

test('proof: changed tests that also pass on the base prove nothing, and are named', () => {
  const r = repo({ 'm.js': 'module.exports = { add: (a, b) => a + b }\n', 'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(1, 1), 2)') })
  r.commit({ 'test/m.test.js': HEAD + T('add', 'assert.equal(m.add(1, 1), 2)') + T('add more', 'assert.equal(m.add(2, 2), 4)') })
  const list = path.join(tmp(), 'tests.txt')
  fs.writeFileSync(list, 'test/m.test.js\n')
  const diff = path.join(tmp(), 'test.diff')
  fs.writeFileSync(diff, r.git('diff', r.base, 'HEAD', '--', 'test/'))
  const out = main(['--repo', r.dir, '--out', path.join(tmp(), 'o'), '--cmd', CMD, '--base', r.base, '--proof-tests', list, '--test-diff', diff])
  assert.equal(out.proof.result, 'Not produced')
  assert.match(out.proof.notes, /also pass on the base/)
  assert.deepEqual(out.proof.passOnBase, ['add more'])
})

test('a changed test is named by its exact title or its definition', () => {
  const { namedIn } = require('../skills/self-review/scripts/run-checks.js')
  const added = "+test('add more', () => {})\n+test('add', () => {})\n+def test_total():\n+func TestSum(t *testing.T) {"
  assert.equal(namedIn(added, 'add'), true)
  assert.equal(namedIn("+test('add more', () => {})", 'add'), false)
  assert.equal(namedIn(added, 'tests/test_x.py::test_total'), true)
  assert.equal(namedIn(added, 'TestSum'), true)
  assert.equal(namedIn(added, 'TestOther'), false)
})

test('parsePasses reads TAP, spec, jest and go output', () => {
  const { parsePasses } = require('../skills/self-review/scripts/run-checks.js')
  assert.deepEqual(parsePasses('ok 1 - a\nnot ok 2 - b\n✔ c (1ms)\n  ✓ d (3 ms)\n--- PASS: TestE (0.00s)\n').sort(), ['TestE', 'a', 'c', 'd'])
})
