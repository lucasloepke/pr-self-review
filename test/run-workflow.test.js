// The Agent-tool driver: prompts out, answers in, repeat until done.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DRIVER = path.join(__dirname, '../skills/self-review/scripts/run-workflow.js')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'psr-drv-'))

function setup(extra = {}) {
  const dir = tmp()
  const argsFile = path.join(dir, 'args.json')
  fs.writeFileSync(argsFile, JSON.stringify({ mode: 'review', repoRoot: '/repo', workDir: '/work', brief: { purpose: 'p' }, ...extra }))
  const runDir = path.join(dir, 'run')
  const drive = (...flags) => {
    const r = spawnSync('node', [DRIVER, argsFile, runDir, ...flags])
    return { status: r.status, out: r.status === 0 ? JSON.parse(r.stdout.toString()) : null, err: r.stderr.toString() }
  }
  const answer = (label, value) => fs.writeFileSync(path.join(runDir, 'answers', `${label}.json`),
    typeof value === 'string' ? value : JSON.stringify(value))
  return { dir, argsFile, runDir, drive, answer }
}

const finding = {
  lens: 'correctness', severity: 'blocking', file: 'src/a.js', line: 3, claim: 'Loop skips the last element of the batch',
  intended: 'every item processed', observed: '`i < n - 1`', failureCase: 'a batch of one item is never processed'
}

test('reviewers, then skeptics, then done', () => {
  const { drive, answer, runDir } = setup()
  let r = drive()
  assert.equal(r.out.status, 'pending')
  assert.deepEqual(r.out.pending.map(p => p.label), ['does-it-work', 'honest-and-maintainable'])
  const prompt = fs.readFileSync(r.out.pending[0].prompt, 'utf8')
  assert.match(prompt, /OUTPUT\. When you are done/)
  assert.ok(prompt.includes(r.out.pending[0].answer))

  answer('does-it-work', { attacksTried: ['a'], findings: [finding] })
  answer('honest-and-maintainable', { attacksTried: ['b'], findings: [] })
  r = drive()
  assert.equal(r.out.status, 'pending')
  assert.equal(r.out.pending.length, 1)
  assert.match(r.out.pending[0].label, /^skeptic:F-[0-9a-f]{6}$/)

  fs.writeFileSync(r.out.pending[0].answer, JSON.stringify({ verdict: 'confirmed', reason: 'shown' }))
  r = drive()
  assert.equal(r.out.status, 'done')
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
  assert.equal(result.findings[0].skeptic, 'confirmed')
})

test('--final treats a missing answer as a failed agent', () => {
  const { drive, answer, runDir } = setup()
  drive()
  answer('honest-and-maintainable', { attacksTried: ['b'], findings: [] })
  const r = drive('--final')
  assert.equal(r.out.status, 'done')
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
  assert.deepEqual(result.counts.reviewersNotRun, ['does-it-work'])
})

test('a malformed answer is a failed agent, listed as invalid', () => {
  const { drive, answer, runDir } = setup()
  drive()
  answer('does-it-work', '{ not json')
  answer('honest-and-maintainable', { attacksTried: [], findings: [] })
  const r = drive()
  assert.equal(r.out.status, 'done')
  assert.equal(r.out.invalid[0].label, 'does-it-work')
  const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
  assert.deepEqual(result.counts.reviewersNotRun, ['does-it-work'])
})

test('a run-dir cannot be reused with different args', () => {
  const s = setup()
  s.drive()
  fs.writeFileSync(s.argsFile, JSON.stringify({ mode: 'review', repoRoot: '/other', workDir: '/work', brief: {} }))
  const r = s.drive()
  assert.notEqual(r.status, 0)
  assert.match(r.err, /different args/)
})

test('missing required args are refused', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ mode: 'review' }))
  const r = spawnSync('node', [DRIVER, path.join(dir, 'a.json'), path.join(dir, 'run')])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr.toString(), /repoRoot/)
})
