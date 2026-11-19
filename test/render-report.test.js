// The report renderer: verdict rule, closed vocabulary, sections, state block.
const test = require('node:test')
const assert = require('node:assert/strict')
const { render } = require('../skills/preflight/scripts/render-report.js')

const f = (id, severity, over) => ({
  id, severity, lens: 'correctness', file: 'src/a.js', line: 4, claim: `claim ${id} with a | pipe`,
  intended: 'i', observed: '`x > y`', failureCase: 'f', skeptic: severity === 'suggestion' ? 'skipped' : 'confirmed', ...over
})
const pass = { result: 'Pass' }
function input(over = {}) {
  return {
    skillVersion: '0.1.0', date: '2026-11-18', mode: 'default', dryRun: false,
    headSha: 'aaaaaaaaaaaa', baseSha: 'bbbbbbbbbbbb', tier: 'Shared', tierReason: 'shared helper',
    brief: { purpose: 'p', acceptance: ['a works'], outOfScope: [] },
    coverage: { 'a works': 'covered' },
    checks: { scope: pass, tests: { result: 'Pass', label: 'local `npm test`' }, regression: pass, e2e: pass,
      proof: { result: 'Provided' }, flagGate: { result: 'Not required' } },
    review: { findings: [], collapsed: { suggestion: [], nit: [] }, rejected: [], carried: [], reviewers: [{}, {}],
      counts: { raised: 0, confirmed: 0, rejected: 0, suppressed: 0, reviewersNotRun: [] } },
    decisions: {},
    ...over
  }
}
const withFindings = (findings, decisions, over) => input({ review: { ...input().review, findings }, decisions, ...over })

test('clean run: Ready for review, says so plainly', () => {
  const { markdown, verdict } = render(input())
  assert.equal(verdict, 'Ready for review')
  assert.match(markdown, /No blocking or important findings\./)
  assert.ok(markdown.startsWith('<!-- preflight -->\n'))
  assert.ok(markdown.endsWith('\n-->\n'))
  assert.doesNotMatch(markdown, /Changes since the last run/)
})

test('verdict: open Blocking or red tests → Not ready', () => {
  assert.equal(render(withFindings([f('F-1', 'blocking')], {})).verdict, 'Not ready')
  assert.equal(render(withFindings([f('F-1', 'blocking')], { 'F-1': { status: 'Open — needs author decision' } })).verdict, 'Not ready')
  assert.equal(render(input({ checks: { ...input().checks, tests: { result: 'Fail', label: 'x' } } })).verdict, 'Not ready')
})

test('verdict: deferred Blocking, open Important, unrun tests, missing proof or a lost reviewer → Ready with open items', () => {
  assert.equal(render(withFindings([f('F-1', 'blocking')], { 'F-1': { status: 'Deferred', reason: 'r' } })).verdict, 'Ready with open items')
  assert.equal(render(withFindings([f('F-1', 'important')], {})).verdict, 'Ready with open items')
  assert.equal(render(input({ checks: { ...input().checks, tests: { result: 'Not run' } } })).verdict, 'Ready with open items')
  assert.equal(render(input({ checks: { ...input().checks, proof: { result: 'Not produced', notes: 'no browser' } } })).verdict, 'Ready with open items')
  const lost = input()
  lost.review.counts.reviewersNotRun = ['does-it-work']
  const r = render(lost)
  assert.equal(r.verdict, 'Ready with open items')
  assert.match(r.markdown, /Reviewer `does-it-work` did not return/)
})

test('screenshots render as a before/after table above the test proof', () => {
  const { markdown } = render(input({
    screenshots: [
      { route: '/orders', before: 'https://github.com/o/r/blob/c/b.png?raw=true', after: 'https://github.com/o/r/blob/c/a.png?raw=true', changed: true },
      { route: '/help', before: 'u1', after: 'u2', changed: false }
    ],
    proof: '| Test | Base | Head |'
  }))
  const section = markdown.split('### 📸 Proof\n')[1].split('\n### ')[0]
  assert.match(section, /^\| Page \| Before \| After \|/)
  assert.match(section, /\| `\/orders` \| <img src="https:\/\/github\.com\/o\/r\/blob\/c\/b\.png\?raw=true" width="400" alt="\/orders before"> \|/)
  assert.match(section, /`\/help` · unchanged/)
  assert.match(section, /\n\n\| Test \| Base \| Head \|/)
})

test('proof this version cannot make (Not run) is shown but does not cap the verdict', () => {
  const r = render(input({ checks: { ...input().checks, proof: { result: 'Not run', notes: 'screenshots not supported yet' } } }))
  assert.equal(r.verdict, 'Ready for review')
  assert.match(r.markdown, /\| Proof \| ⏭️ Not run \| screenshots not supported yet \|/)
  assert.match(r.markdown, /- Proof: not run — screenshots not supported yet/)
})

test('verdict: fixed serious findings and open suggestions → Ready for review', () => {
  const r = render(withFindings([f('F-1', 'blocking'), f('F-2', 'suggestion')], { 'F-1': { status: 'Fixed', commit: '1234567890', evidence: 'quoted fix' } }))
  assert.equal(r.verdict, 'Ready for review')
  assert.match(r.markdown, /Fixed in `1234567` — quoted fix/)
  assert.match(r.markdown, /Suggestions and nits not taken \(1\)/)
})

test('a dry-run fix with no commit reads "Fixed in working tree"', () => {
  const r = render(withFindings([f('F-1', 'important')], { 'F-1': { status: 'Fixed' } }, { dryRun: true }))
  assert.match(r.markdown, /Fixed in working tree/)
  assert.match(r.markdown, /· dry run/)
})

test('statuses and check results outside the vocabulary are refused', () => {
  assert.throws(() => render(withFindings([f('F-1', 'important')], { 'F-1': { status: 'Wontfix' } })), /decisions\.F-1\.status/)
  assert.throws(() => render(input({ checks: { ...input().checks, e2e: { result: 'Skipped' } } })), /checks\.e2e\.result/)
})

test('state block parses, holds every finding, and contains no raw ">"', () => {
  const { markdown } = render(withFindings([f('F-1', 'blocking'), f('F-2', 'suggestion')], { 'F-1': { status: 'Declined', reason: 'by design -->' } }))
  const json = markdown.split('<!-- preflight:state v1\n')[1].split('\n-->')[0]
  assert.doesNotMatch(json, />/)
  const state = JSON.parse(json)
  assert.deepEqual(state.findings.map(x => [x.id, x.status]), [['F-1', 'Declined'], ['F-2', 'Open']])
  assert.equal(state.findings[0].observed, '`x > y`')
  assert.match(markdown, /Decisions worth a second opinion:\*\* F-1/)
})

test('pipes in claims do not break the table', () => {
  const { markdown } = render(withFindings([f('F-1', 'important')], {}))
  assert.match(markdown, /claim F-1 with a \\\| pipe/)
})

test('a re-run lists resolved, carried over and newly raised', () => {
  const prior = { findings: [
    { id: 'F-1', severity: 'blocking', status: 'Open', file: 'src/a.js', claim: 'c1' },
    { id: 'F-2', severity: 'important', status: 'Deferred', reason: 'ticket 9', file: 'src/b.js', claim: 'c2' }
  ] }
  const review = { ...input().review,
    findings: [f('F-1', 'blocking'), f('F-3', 'important')],
    carried: [{ ...f('F-2', 'important'), priorStatus: 'Deferred' }] }
  const { markdown } = render(input({ review, prior, decisions: { 'F-1': { status: 'Fixed', commit: 'abcdef0' } } }))
  assert.match(markdown, /- Resolved: F-1/)
  assert.match(markdown, /- Carried over: None/)
  assert.match(markdown, /- Newly raised: F-3/)
  assert.match(markdown, /\| F-2 \| 🟠 Important .* \| 📌 Deferred — ticket 9 \|/)
})

test('prior findings not raised this run stay on the record and in the state', () => {
  const prior = { findings: [
    { id: 'F-1', severity: 'blocking', status: 'Fixed in abcdef0123', commit: 'abcdef0123', evidence: 'esc() added', file: 'a.js', claim: 'x' },
    { id: 'F-2', severity: 'nit', status: 'Open', file: 'b.css', claim: 'y' },
    { id: 'F-3', severity: 'important', status: 'Deferred', reason: 'ticket 9', file: 'c.js', claim: 'z' }
  ] }
  const { markdown, verdict } = render(input({ prior, review: { ...input().review, findings: [f('F-9', 'important')] },
    decisions: { 'F-1': { status: 'Fixed', commit: 'abcdef0123', evidence: 're-verified after push' }, 'F-9': { status: 'Deferred', reason: 'next PR' } } }))
  const state = JSON.parse(markdown.split('<!-- preflight:state v1\n')[1].split('\n-->')[0])
  assert.deepEqual(state.findings.map(x => [x.id, x.status]).sort(), [['F-1', 'Fixed in abcdef0123'], ['F-2', 'Open'], ['F-3', 'Deferred'], ['F-9', 'Deferred']])
  assert.match(markdown, /\| F-1 \| 🔴 Blocking .* ✅ Fixed in `abcdef0` — re-verified after push \|/)
  assert.match(markdown, /- Newly raised: F-9/)
  assert.equal(verdict, 'Ready with open items')
})

test('emojis mark verdict, severity, results and status; the state block stays plain', () => {
  const { markdown } = render(withFindings([f('F-1', 'blocking'), f('F-2', 'important')],
    { 'F-1': { status: 'Fixed', commit: 'abcdef0' } },
    { checks: { ...input().checks, e2e: { result: 'Not run' } } }))
  assert.match(markdown, /\*\*Verdict:\*\* 🟡 Ready with open items/)
  assert.match(markdown, /\| F-1 \| 🔴 Blocking .* \| 🎯 Confirmed \| ✅ Fixed in `abcdef0` \|/)
  assert.match(markdown, /\| F-2 \| 🟠 Important .* \| 🔓 Open \|/)
  assert.match(markdown, /\| End-to-end \| ⏭️ Not run \|/)
  assert.match(markdown, /a works — ✅ covered/)
  const state = markdown.split('<!-- preflight:state v1\n')[1]
  assert.doesNotMatch(state, /[🔴🟠🔵⚪✅🔓📌🚫🎯]/u)
})
