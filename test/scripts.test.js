// gather.sh against a throwaway repo with no PR, and post-report.sh against a
// stand-in `gh` that records how it was called.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const SCRIPTS = path.join(__dirname, '../skills/self-review/scripts')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psr-test-'))

// A `gh` that logs its arguments and answers from FAKE_* variables.
function fakeGh(dir, body) {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\n${body}\n`, { mode: 0o755 })
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` }
}

function repo() {
  const dir = tmp()
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString()
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s) }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
  write('src/a.js', 'export const a = 1\n'); write('README.md', 'hi\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  git('switch', '-qc', 'feature/x')
  write('src/a.js', 'export const a = 2\n')
  write('src/a.test.js', 'test("a", () => {})\n')
  write('tests/helper.js', 'module.exports = {}\n')
  write('CLAUDE.md', 'rules\n')
  git('add', '-A'); git('commit', '-qm', 'change a')
  return { dir, git, write }
}

test('gather: no PR → diff against the default branch, partitioned into prod and test', () => {
  const { dir } = repo()
  const env = fakeGh(tmp(), 'exit 1')
  const out = path.join(tmp(), 'w')
  execFileSync('bash', [path.join(SCRIPTS, 'gather.sh'), '--out', out], { cwd: dir, env, stdio: 'pipe' })
  const read = f => fs.readFileSync(path.join(out, f), 'utf8')

  assert.deepEqual(read('files-prod.txt').trim().split('\n'), ['CLAUDE.md', 'src/a.js'])
  assert.deepEqual(read('files-test.txt').trim().split('\n'), ['src/a.test.js', 'tests/helper.js'])
  assert.match(read('prod.diff'), /export const a = 2/)
  assert.doesNotMatch(read('prod.diff'), /a\.test\.js/)
  assert.match(read('test.diff'), /a\.test\.js/)
  assert.doesNotMatch(read('test.diff'), /export const a = 2/)
  assert.match(read('commits.txt'), /change a/)
  assert.equal(read('conventions.txt').trim(), 'CLAUDE.md')
  const meta = read('meta.txt')
  assert.match(meta, /^pr: none$/m)
  assert.match(meta, /^base: main$/m)
  assert.match(meta, /^ci: none$/m)
  assert.match(meta, /^dirty: no$/m)
  assert.match(meta, /^changedLines: 5$/m)
  assert.ok(!fs.existsSync(path.join(out, 'pr.json')))
})

test('gather: --since narrows the diff; an all-test range leaves prod.diff empty', () => {
  const { dir, git, write } = repo()
  const since = git('rev-parse', 'HEAD').trim()
  write('src/b.spec.ts', 'it("b", () => {})\n')
  git('add', '-A'); git('commit', '-qm', 'more tests')
  write('scratch.txt', 'uncommitted\n')
  const out = path.join(tmp(), 'w')
  execFileSync('bash', [path.join(SCRIPTS, 'gather.sh'), '--since', since, '--out', out],
    { cwd: dir, env: fakeGh(tmp(), 'exit 1'), stdio: 'pipe' })
  const read = f => fs.readFileSync(path.join(out, f), 'utf8')
  assert.equal(read('files-test.txt').trim(), 'src/b.spec.ts')
  assert.equal(read('prod.diff'), '')
  assert.match(read('commits.txt'), /change a/)
  assert.match(read('meta.txt'), /^dirty: yes$/m)
})

test('gather: --description and --issue give a no-PR branch a title, body and ticket', () => {
  const { dir } = repo()
  const files = tmp()
  fs.writeFileSync(path.join(files, 'desc.md'), '# Bump a to 2\n\nChanges a.\nFixes #3\n')
  fs.writeFileSync(path.join(files, 'issue.md'), 'Ticket 3\nPlease make a two.\n')
  const out = path.join(tmp(), 'w')
  execFileSync('bash', [path.join(SCRIPTS, 'gather.sh'), '--out', out,
    '--description', path.join(files, 'desc.md'), '--issue', path.join(files, 'issue.md')],
    { cwd: dir, env: fakeGh(tmp(), 'exit 1'), stdio: 'pipe' })
  const pr = JSON.parse(fs.readFileSync(path.join(out, 'pr.json'), 'utf8'))
  assert.equal(pr.title, 'Bump a to 2')
  assert.equal(pr.body, 'Changes a.\nFixes #3')
  const issue = JSON.parse(fs.readFileSync(path.join(out, 'issue.json'), 'utf8'))
  assert.deepEqual([issue.title, issue.body], ['Ticket 3', 'Please make a two.'])
})

test('gather: --description is refused when the branch has a PR', () => {
  const { dir } = repo()
  const files = tmp()
  fs.writeFileSync(path.join(files, 'desc.md'), 'x\n')
  const gh = `case "$*" in "pr view --json number"*) printf '7\\tmain\\tfeature/x\\tabc\\tOPEN\\n';; esac; exit 0`
  const r = spawnSync('bash', [path.join(SCRIPTS, 'gather.sh'), '--out', path.join(tmp(), 'w'), '--description', path.join(files, 'desc.md')],
    { cwd: dir, env: fakeGh(tmp(), gh) })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr.toString(), /own description/)
})

test('gather: refuses the default branch with no PR', () => {
  const { dir, git } = repo()
  git('switch', '-q', 'main')
  const r = spawnSync('bash', [path.join(SCRIPTS, 'gather.sh'), '--out', path.join(tmp(), 'w')],
    { cwd: dir, env: fakeGh(tmp(), 'exit 1') })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr.toString(), /nothing to review/)
})

const REPORT = '<!-- pr-self-review -->\n## Self-review report\n\n<!-- pr-self-review:state v1\n{"reviewedSha":"abc"}\n-->\n'
const GH = `
case "$*" in
  "pr view"*) echo "\${FAKE_STATE:-OPEN}" ;;
  *"-X PATCH"*) echo "https://example.test/edited" ;;
  api*) [ -n "\${FAKE_COMMENT_ID:-}" ] && echo "$FAKE_COMMENT_ID" ;;
  "pr comment"*) echo "https://example.test/created" ;;
esac
exit 0`

function post(report, vars = {}) {
  const dir = tmp()
  const file = path.join(dir, 'report.md')
  fs.writeFileSync(file, report)
  const r = spawnSync('bash', [path.join(SCRIPTS, 'post-report.sh'), '7', file], { env: { ...fakeGh(dir, GH), ...vars } })
  const log = fs.existsSync(path.join(dir, 'gh.log')) ? fs.readFileSync(path.join(dir, 'gh.log'), 'utf8') : ''
  return { status: r.status, out: r.stdout.toString().trim(), err: r.stderr.toString(), log, file }
}

test('post-report: creates the comment when none exists', () => {
  const r = post(REPORT)
  assert.equal(r.status, 0, r.err)
  assert.equal(r.out, 'https://example.test/created')
  assert.match(r.log, new RegExp(`pr comment 7 --body-file ${r.file}`))
  assert.doesNotMatch(r.log, /PATCH/)
})

test('post-report: edits the existing comment instead of adding a second', () => {
  const r = post(REPORT, { FAKE_COMMENT_ID: '4242' })
  assert.equal(r.status, 0, r.err)
  assert.equal(r.out, 'https://example.test/edited')
  assert.match(r.log, /-X PATCH repos\/\{owner\}\/\{repo\}\/issues\/comments\/4242/)
  assert.doesNotMatch(r.log, /pr comment/)
})

test('post-report: refuses a merged PR and malformed reports without calling gh to post', () => {
  const merged = post(REPORT, { FAKE_STATE: 'MERGED' })
  assert.notEqual(merged.status, 0)
  assert.match(merged.err, /MERGED/)
  assert.doesNotMatch(merged.log, /pr comment|PATCH/)

  const noMarker = post(REPORT.replace('<!-- pr-self-review -->\n', ''))
  assert.notEqual(noMarker.status, 0)
  assert.equal(noMarker.log, '')

  const noState = post('<!-- pr-self-review -->\n## Self-review report\n')
  assert.notEqual(noState.status, 0)
  assert.match(noState.err, /state block/)
})
