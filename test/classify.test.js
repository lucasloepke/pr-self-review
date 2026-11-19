const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { main, glob } = require('../skills/self-review/scripts/classify.js')

function setup(files, changedProd, changedTests = [], config = null) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-cls-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-clsw-'))
  for (const [f, s] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s) }
  if (config) { fs.mkdirSync(path.join(repo, '.self-review'), { recursive: true }); fs.writeFileSync(path.join(repo, '.self-review/config.yml'), config) }
  execFileSync('git', ['init', '-q'], { cwd: repo }); execFileSync('git', ['add', '-A'], { cwd: repo })
  fs.writeFileSync(path.join(work, 'files-prod.txt'), changedProd.join('\n'))
  fs.writeFileSync(path.join(work, 'files-test.txt'), changedTests.join('\n'))
  const r = main(['--repo', repo, '--work', work])
  return { r, by: Object.fromEntries(r.areas.map(a => [a.file, a])) }
}

test('glob: ** spans folders, * stays within one', () => {
  assert.ok(glob('src/payments/**').test('src/payments/a/b.js'))
  assert.ok(glob('**/*.sql').test('db/x/y.sql'))
  assert.ok(!glob('src/*.js').test('src/a/b.js'))
})

test('fan-in makes a helper Shared; a route stays Leaf; tests take their code\'s tier', () => {
  const { r, by } = setup({
    'src/paginate.js': 'module.exports = {}\n',
    'src/routes/orders.js': "const { paginate } = require('../paginate')\n",
    'src/routes/customers.js': "import { paginate } from '../paginate.js'\n",
    'test/paginate.test.js': "require('../src/paginate')\n",
    'test/orders.test.js': "require('../src/routes/orders')\n"
  }, ['src/paginate.js', 'src/routes/orders.js'], ['test/paginate.test.js', 'test/orders.test.js'])
  assert.equal(by['src/paginate.js'].tier, 'Shared')
  assert.equal(by['src/paginate.js'].fanIn, 2)
  assert.equal(by['src/routes/orders.js'].tier, 'Leaf')
  assert.equal(by['src/routes/orders.js'].kind, 'api-cli')
  assert.equal(by['test/paginate.test.js'].tier, 'Shared')
  assert.equal(by['test/orders.test.js'].tier, 'Leaf')
  assert.equal(r.tier, 'Shared')
})

test('Core paths, Inert docs, visual kinds', () => {
  const { r, by } = setup({ 'a.js': '' }, ['src/auth/session.js', 'db/migrations/001_init.sql', '.github/workflows/ci.yml', 'README.md', 'src/components/Button.tsx', 'src/styles/main.css', 'src/views/pages.js'])
  assert.equal(by['src/views/pages.js'].kind, 'visual')
  assert.equal(by['src/auth/session.js'].tier, 'Core')
  assert.equal(by['db/migrations/001_init.sql'].tier, 'Core')
  assert.equal(by['.github/workflows/ci.yml'].tier, 'Core')
  assert.equal(by['README.md'].tier, 'Inert')
  assert.equal(by['src/components/Button.tsx'].kind, 'visual')
  assert.equal(by['src/styles/main.css'].tier, 'Leaf')
  assert.equal(r.tier, 'Core')
})

test('config tiers win and are marked binding; fan-in threshold is configurable', () => {
  const { by } = setup({
    'src/x.js': '', 'src/a.js': "require('./x')\n", 'src/auth/token.js': ''
  }, ['src/x.js', 'src/auth/token.js'], [], 'tiers:\n  Leaf:\n    - "src/auth/**"\nfanInShared: 1\n')
  assert.equal(by['src/auth/token.js'].tier, 'Leaf')
  assert.equal(by['src/auth/token.js'].binding, true)
  assert.equal(by['src/x.js'].tier, 'Shared')
})

test('python imports count toward fan-in', () => {
  const { by } = setup({
    'app/util/money.py': '', 'app/a.py': 'from app.util.money import fmt\n', 'app/b.py': 'import app.util.money\n'
  }, ['app/util/money.py'])
  assert.equal(by['app/util/money.py'].fanIn, 2)
  assert.equal(by['app/util/money.py'].tier, 'Shared')
})
