const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { main } = require('../skills/preflight/scripts/scan.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psr-scan-'))

function setup({ diff = '', prod = [], config = null } = {}) {
  const repo = tmp(), work = tmp()
  fs.writeFileSync(path.join(work, 'full.diff'), diff)
  fs.writeFileSync(path.join(work, 'files-prod.txt'), prod.join('\n'))
  if (config) { fs.mkdirSync(path.join(repo, '.preflight')); fs.writeFileSync(path.join(repo, '.preflight', 'config.yml'), config) }
  return { repo, work, run: () => main(['--repo', repo, '--work', work]) }
}

test('secrets added by the diff become a lead; removed ones do not', () => {
  const s = setup({ diff: '+++ b/.env\n-OLD_SECRET=abcd1234efgh\n+NEW_SECRET=zzzz9999yyyy\n' })
  const r = s.run()
  assert.deepEqual(r.leads, ['leads/secrets.json'])
  const lead = JSON.parse(fs.readFileSync(path.join(s.work, 'leads/secrets.json'), 'utf8'))
  assert.deepEqual(lead.hits.map(h => h.line), [3])
  assert.doesNotMatch(JSON.stringify(lead), /zzzz9999yyyy/)
})

test('a clean diff gives no leads; npm audit is skipped when dependencies did not change', () => {
  const r = setup({ diff: '+const a = 1\n', prod: ['src/a.js'] }).run()
  assert.deepEqual(r.leads, [])
  assert.deepEqual(r.skipped.map(s => s.name), ['npm-audit'])
})

test('configured scanners run in the repo and their output becomes a lead', () => {
  const s = setup({ config: 'scanners:\n  - name: hello\n    cmd: echo found-something && pwd\n  - name: broken\n' })
  const r = s.run()
  assert.deepEqual(r.leads, ['leads/hello.txt'])
  const out = fs.readFileSync(path.join(s.work, 'leads/hello.txt'), 'utf8')
  assert.match(out, /found-something/)
  assert.ok(out.includes(fs.realpathSync(s.repo)) || out.includes(s.repo))
  assert.deepEqual(r.skipped.map(x => x.name), ['npm-audit', 'broken'])
})
