// capture.js (needs Chrome; skipped without it) and publish-assets.sh (against a local bare remote).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const capture = require('../skills/preflight/scripts/capture.js')

const SCRIPTS = path.join(__dirname, '../skills/preflight/scripts')
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psr-cap-')))

function repo() {
  const dir = tmp()
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  return { dir, git }
}

const SERVER = color => `require('http').createServer((q, s) => { s.writeHead(200, {'content-type':'text/html'});
  s.end('<body style="margin:0;background:${color}"><h1 style="font:20px sans-serif">' + q.url + '</h1></body>') })
  .listen(Number(process.env.PORT))\n`

test('capture: base and head on their own ports, changed pages flagged', { skip: !capture.findChrome() && 'no Chrome' }, async () => {
  const r = repo()
  fs.writeFileSync(path.join(r.dir, 'server.js'), SERVER('#ffffff'))
  r.git('add', '-A'); r.git('commit', '-qm', 'base')
  const base = r.git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(r.dir, 'server.js'), SERVER('#ffeeee'))
  r.git('commit', '-qam', 'head')
  const out = path.join(tmp(), 'shots')
  const res = await capture.main(['--repo', r.dir, '--base', base, '--out', out, '--start', 'node server.js', '--routes', '/a,b', '--viewport', '400x300'])
  assert.equal(res.notRun, null)
  assert.deepEqual(res.pages.map(p => [p.route, p.changed]), [['/a', true], ['/b', true]])
  assert.ok(fs.statSync(path.join(out, 'before', 'a.png')).size > 0)
  assert.equal(r.git('worktree', 'list').split('\n').length, 1)
})

test('capture: an app that will not start is reported, not thrown', { skip: !capture.findChrome() && 'no Chrome' }, async () => {
  const r = repo()
  fs.writeFileSync(path.join(r.dir, 'x.txt'), 'x'); r.git('add', '-A'); r.git('commit', '-qm', 'base')
  const res = await capture.main(['--repo', r.dir, '--base', 'HEAD', '--out', path.join(tmp(), 's'), '--start', 'node -e "process.exit(3)"', '--routes', '/', '--ready-timeout', '5'])
  assert.match(res.notRun, /did not start/)
})

test('publish-assets: commits images to the assets branch, keeps earlier ones, leaves the checkout alone', () => {
  const remote = tmp()
  execFileSync('git', ['init', '-q', '--bare', remote])
  const r = repo()
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'a'); r.git('add', '-A'); r.git('commit', '-qm', 'base')
  r.git('remote', 'add', 'origin', remote)
  fs.writeFileSync(path.join(r.dir, 'wip.txt'), 'uncommitted')
  const img = n => { const f = path.join(tmp(), `${n}.png`); fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, n])); return f }
  const env = { ...process.env, PREFLIGHT_REPO: 'owner/repo' }
  const publish = (...a) => {
    const p = spawnSync('bash', [path.join(SCRIPTS, 'publish-assets.sh'), ...a], { cwd: r.dir, env })
    assert.equal(p.status, 0, p.stderr.toString())
    return JSON.parse(p.stdout.toString())
  }
  const first = publish('7', 'abcdef1234567890', img(1), img(2))
  assert.equal(first.files[0].path, 'pr-7/abcdef123456/1.png')
  assert.equal(first.files[0].url, `https://github.com/owner/repo/blob/${first.commit}/pr-7/abcdef123456/1.png?raw=true`)
  publish('8', '1111111aaaaaaa', img(3))
  const tree = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'preflight-assets']).toString().trim().split('\n')
  assert.deepEqual(tree, ['pr-7/abcdef123456/1.png', 'pr-7/abcdef123456/2.png', 'pr-8/1111111aaaaa/3.png'])
  assert.equal(r.git('branch', '--show-current'), 'main')
  assert.match(r.git('status', '--porcelain'), /^\?\? wip\.txt$/)
})

test('publish-assets: refuses non-images', () => {
  const r = repo()
  const f = path.join(tmp(), 'x.txt'); fs.writeFileSync(f, 'x')
  const p = spawnSync('bash', [path.join(SCRIPTS, 'publish-assets.sh'), '7', 'abcdef1', f], { cwd: r.dir, env: { ...process.env, PREFLIGHT_REPO: 'o/r' } })
  assert.notEqual(p.status, 0)
  assert.match(p.stderr.toString(), /not an image/)
})
