const test = require('node:test')
const assert = require('node:assert/strict')
const { parse, stringifyList } = require('../skills/self-review/scripts/lib/yaml-lite.js')

test('config shape: nested maps, lists, flow lists, comments, quoting', () => {
  const v = parse(`
# per-repo settings
tiers:
  Core:
    - "src/payments/**"
    - 'infra/**'   # trailing comment
  Shared: [src/lib/**, "src/hooks/**"]
fanInShared: 3
reviewers: null
scanners:
  - name: lint
    cmd: "npm run lint -- --format json"
  - name: audit
    cmd: npm audit --json
`)
  assert.deepEqual(v, {
    tiers: { Core: ['src/payments/**', 'infra/**'], Shared: ['src/lib/**', 'src/hooks/**'] },
    fanInShared: 3, reviewers: null,
    scanners: [{ name: 'lint', cmd: 'npm run lint -- --format json' }, { name: 'audit', cmd: 'npm audit --json' }]
  })
})

test('a list may sit at its key\'s own indent', () => {
  assert.deepEqual(parse('items:\n- a\n- b\nnext: 1\n'), { items: ['a', 'b'], next: 1 })
})

test('# inside quotes is not a comment; empty document is null', () => {
  assert.deepEqual(parse('a: "x # y"\nb: it\'s # c\n'), { a: 'x # y', b: "it's" })
  assert.equal(parse('# nothing\n'), null)
})

test('unsupported syntax and bad indentation throw', () => {
  assert.throws(() => parse('a: |\n  text\n'), /unsupported/)
  assert.throws(() => parse('a: {b: 1}\n'), /unsupported/)
  assert.throws(() => parse('a: 1\n   b: 2\n'), /indentation/)
})

test('stringifyList round-trips', () => {
  const items = [{ pattern: 'console.log in "scripts/"', reason: 'CLI output', by: 'x', date: '2026-11-18' }]
  const text = stringifyList('suppressions', items, '# header\n')
  assert.deepEqual(parse(text), { suppressions: items })
  assert.deepEqual(parse(stringifyList('suppressions', [])), { suppressions: [] })
})
