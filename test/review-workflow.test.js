// Runs review-workflow.js with stand-in agents, to test the rules it applies
// in code: ceilings, de-duplication, ids, prior decisions, skeptic verdicts, caps.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '../skills/preflight/review-workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflow = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SRC)

// respond(label, prompt) → what that agent returns (undefined → agent failed)
async function run(args, respond) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt })
    const r = respond(opts.label, prompt)
    return r === undefined ? null : r
  }
  const parallel = fns => Promise.all(fns.map(fn => fn()))
  const result = await workflow(
    { repoRoot: '/repo', workDir: '/work', skillDir: '/skill', brief: { purpose: 'p' }, ...args },
    agent, parallel, () => {}, () => {})
  return { result, calls, labels: calls.map(c => c.label) }
}

const finding = over => ({
  lens: 'correctness', severity: 'blocking', file: 'src/a.js', line: 10,
  claim: 'Token expiry is compared in seconds against a millisecond timestamp',
  intended: 'tokens expire after ttl seconds', observed: '`Date.now() > token.exp`',
  failureCase: 'any token looks expired, every request returns 401', ...over
})
const review = (findings, extra) => ({ attacksTried: ['tried x'], findings, ...extra })
const confirm = { verdict: 'confirmed', reason: 'path shown' }

// Shared tier: reviewer "does-it-work" returns `works`, the other returns `maint`.
const shared = (works, maint, skeptic) => (label, prompt) => {
  if (label === 'does-it-work') return review(works)
  if (label === 'honest-and-maintainable') return review(maint)
  if (label.startsWith('skeptic:')) return skeptic ? skeptic(label, prompt) : confirm
}

test('reviewer count follows the tier', async () => {
  const empty = () => review([])
  assert.deepEqual((await run({ tier: 'Inert' }, empty)).labels, [])
  assert.deepEqual((await run({ tier: 'Leaf' }, empty)).labels, ['all-lenses'])
  assert.deepEqual((await run({}, empty)).labels, ['does-it-work', 'honest-and-maintainable'])
  assert.equal((await run({ tier: 'Core' }, empty)).labels.length, 4)
  assert.equal((await run({ tier: 'Core', changedLines: 400 }, empty)).labels.length, 5)
})

test('test diff goes only to reviewers carrying the test lens', async () => {
  const { calls } = await run({}, () => review([]))
  const prompt = label => calls.find(c => c.label === label).prompt
  assert.ok(!prompt('does-it-work').includes('/work/test.diff'))
  assert.ok(prompt('honest-and-maintainable').includes('/work/test.diff'))
  assert.ok(prompt('does-it-work').includes('/work/prod.diff'))
})

test('a clean run is a normal result and keeps the attacks tried', async () => {
  const { result, labels } = await run({}, () => review([]))
  assert.deepEqual(result.findings, [])
  assert.equal(result.counts.raised, 0)
  assert.equal(labels.filter(l => l.startsWith('skeptic')).length, 0)
  assert.deepEqual(result.reviewers[0].attacksTried, ['tried x'])
})

test('severity ceilings are applied per lens', async () => {
  const { result } = await run({}, shared([], [
    finding({ lens: 'tests', file: 't.js', claim: 'No test covers the expiry branch at all' }),
    finding({ lens: 'simplification', file: 's.js', claim: 'Wrapper class has a single caller and adds nothing' }),
    finding({ lens: 'style', file: 'n.js', claim: 'Variable naming breaks the documented convention' })
  ]))
  const sev = Object.fromEntries(result.findings.map(f => [f.file, f]))
  assert.equal(sev['t.js'].severity, 'important')
  assert.equal(sev['s.js'].severity, 'suggestion')
  assert.equal(sev['n.js'].severity, 'nit')
  assert.equal(sev['t.js'].raisedAs, 'blocking')
  assert.equal(sev['t.js'].capped, true)
})

test('a finding without a failure case is discarded, not raised', async () => {
  const { result } = await run({}, shared([finding({ failureCase: '  ' })], []))
  assert.equal(result.findings.length, 0)
  assert.equal(result.discarded.length, 1)
  assert.match(result.discarded[0].why, /failureCase/)
})

test('same file, nearby line, same claim is one finding; highest severity wins', async () => {
  const { result } = await run({}, shared(
    [finding({ severity: 'important' })],
    [finding({ lens: 'ai-failure-modes', line: 12, claim: 'Token expiry compared in seconds against millisecond timestamp' }),
     finding({ line: 200, claim: 'Unrelated: retry loop never terminates when the queue is empty' })]))
  assert.equal(result.findings.length, 2)
  const merged = result.findings.find(f => f.line !== 200)
  assert.equal(merged.severity, 'important')
  assert.equal(merged.alsoRaisedBy.length, 1)
})

test('one defect worded differently by two reviewers is merged when they quote the same code', async () => {
  const quote = '`const page = Number(query.page) || 1` then `paginate(store.customers(), page, size)`'
  const { result } = await run({}, shared(
    [finding({ lens: 'callers', file: 'src/routes/customers.js', line: 4, observed: quote,
      claim: 'The customer listing still defaults page to 1, so after paginate became 0-based it skips the first page of customers by default.' })],
    [finding({ lens: 'ai-failure-modes', file: 'src/routes/customers.js', line: 4, observed: quote,
      claim: 'Switching shared paginate to 0-based without updating its other caller makes the customer listing skip its first page, with no way to request it.' }),
     finding({ lens: 'error-handling', file: 'src/routes/customers.js', line: 5, observed: '`catch (e) { return [] }`',
      claim: 'A missing config is caught and silently turned into an empty allow-list.' })]))
  assert.equal(result.findings.length, 2)
  const merged = result.findings.find(f => f.line === 4)
  assert.equal(merged.lens, 'callers')
  assert.equal(merged.severity, 'blocking')
})

test('ids are F- plus six hex digits and stable for the same file and claim', async () => {
  const a = (await run({}, shared([finding()], []))).result.findings[0].id
  const b = (await run({}, shared([finding({ line: 90 })], []))).result.findings[0].id
  assert.match(a, /^F-[0-9a-f]{6}$/)
  assert.equal(a, b)
})

test('only Blocking and Important go to the skeptic', async () => {
  const maint = [finding({ lens: 'simplification', file: 's.js', claim: 'Wrapper class has a single caller and adds nothing' })]
  const normal = await run({}, shared([finding()], maint))
  assert.equal(normal.labels.filter(l => l.startsWith('skeptic')).length, 1)
  assert.equal(normal.result.findings.find(f => f.file === 's.js').skeptic, 'skipped')
  const dontStop = await run({ dontStop: true }, shared([finding()], maint))
  assert.equal(dontStop.labels.filter(l => l.startsWith('skeptic')).length, 2)
})

test('the skeptic gets the finding, not the brief', async () => {
  const { calls } = await run({ brief: { purpose: 'SECRET-PURPOSE' } }, shared([finding()], []))
  const skeptic = calls.find(c => c.label.startsWith('skeptic'))
  assert.ok(skeptic.prompt.includes('every request returns 401'))
  assert.ok(!skeptic.prompt.includes('SECRET-PURPOSE'))
})

test('skeptic verdicts: rejected leaves, reduced lowers, unproven and failures are kept', async () => {
  const fs4 = ['a', 'b', 'c', 'd'].map((n, i) => finding({
    file: `${n}.js`, claim: ['Alpha cache key omits tenant', 'Beta loop skips final element', 'Gamma handler leaks descriptor', 'Delta parser accepts negative length'][i] }))
  const { result } = await run({}, shared(fs4, [], (label, prompt) => {
    if (prompt.includes('a.js')) return { verdict: 'rejected', reason: 'guarded' }
    if (prompt.includes('b.js')) return { verdict: 'reduced', reason: 'narrow', newSeverity: 'important' }
    if (prompt.includes('c.js')) return { verdict: 'unproven', reason: 'needs runtime' }
    return undefined
  }))
  const by = Object.fromEntries(result.findings.map(f => [f.file, f]))
  assert.equal(by['a.js'], undefined)
  assert.equal(result.rejected[0].file, 'a.js')
  assert.equal(by['b.js'].severity, 'important')
  assert.equal(by['b.js'].skeptic, 'reduced')
  assert.equal(by['c.js'].skeptic, 'unproven')
  assert.equal(by['d.js'].skeptic, 'unproven')
  assert.equal(by['d.js'].severity, 'blocking')
  assert.equal(result.counts.rejected, 1)
})

test('"reduced" cannot raise a severity', async () => {
  const { result } = await run({}, shared([finding({ severity: 'important' })], [],
    () => ({ verdict: 'reduced', reason: 'x', newSeverity: 'blocking' })))
  assert.equal(result.findings[0].severity, 'important')
  assert.equal(result.findings[0].skeptic, 'confirmed')
})

test('findings already decided on an earlier run are carried, not raised again', async () => {
  const prior = [
    { id: 'F-aaaaaa', file: 'src/a.js', line: 3, severity: 'blocking', status: 'Declined',
      claim: 'Token expiry compared in seconds against a millisecond timestamp' },
    { id: 'F-bbbbbb', file: 's.js', severity: 'suggestion', status: 'Open',
      claim: 'Wrapper class has a single caller and adds nothing' },
    { id: 'F-cccccc', file: 'o.js', severity: 'important', status: 'Open',
      claim: 'Retry loop never terminates when the queue is empty' }
  ]
  const { result, labels } = await run({ priorFindings: prior }, shared(
    [finding(), finding({ file: 'o.js', claim: 'Retry loop never terminates when queue is empty' })],
    [finding({ lens: 'simplification', file: 's.js', claim: 'Wrapper class has a single caller and adds nothing' })]))
  assert.deepEqual(result.carried.map(f => f.id).sort(), ['F-aaaaaa', 'F-bbbbbb'])
  assert.deepEqual(result.findings.map(f => f.id), ['F-cccccc'])
  assert.equal(result.findings[0].priorStatus, 'Open')
  assert.equal(labels.filter(l => l.startsWith('skeptic')).length, 1)
})

test('a prior finding reworded on the next run keeps its id and stays decided (real pair from the sandbox)', async () => {
  const prior = [{ id: 'F-d746a5', file: 'public/styles.css', severity: 'suggestion', status: 'Open',
    claim: 'A status with no matching .status-* rule renders as white text on the pale-yellow VIP background, i.e. unreadable.',
    observed: '.badge { display: block; width: 88px; color: #fff; } /* no background */ and .badge { background: #fff8c5; }',
    failureCase: 'An order with status refunded gets white text on a pale yellow badge and cannot be read.' }]
  const { result } = await run({ priorFindings: prior }, shared([], [finding({
    lens: 'correctness', severity: 'suggestion', file: 'public/styles.css', line: 14,
    claim: "A status outside the four styled values gets white text on the base badge's pale-yellow background, making it unreadable.",
    observed: '.badge { display: block; width: 88px; color: #fff; } with the earlier .badge { background: #fff8c5; } still applying',
    failureCase: 'A refunded order shows white text on a pale yellow badge that cannot be read.' })]))
  assert.deepEqual(result.carried.map(f => f.id), ['F-d746a5'])
  assert.equal(result.findings.length, 0)
})

test('lite: one reviewer whatever the tier, no skeptics, serious findings kept as unproven', async () => {
  const maint = [finding({ lens: 'simplification', file: 's.js', claim: 'Wrapper class has a single caller and adds nothing' })]
  const { result, labels } = await run({ lite: true, tier: 'Core', changedLines: 900 },
    label => (label === 'all-lenses' ? review([finding(), ...maint]) : undefined))
  assert.deepEqual(labels, ['all-lenses'])
  assert.equal(result.lite, true)
  const by = Object.fromEntries(result.findings.map(f => [f.file, f]))
  assert.equal(by['src/a.js'].skeptic, 'unproven')
  assert.match(by['src/a.js'].skepticReason, /Lite run/)
  assert.equal(by['s.js'].skeptic, 'skipped')
  assert.equal((await run({ lite: true, tier: 'Inert' }, () => review([]))).labels.length, 0)
})

test('after a lite run, its Suggestions and Nits are not treated as already raised', async () => {
  const prior = [{ id: 'F-bbbbbb', file: 's.js', severity: 'suggestion', status: 'Open', claim: 'Wrapper class has a single caller and adds nothing' }]
  const maint = [finding({ lens: 'simplification', file: 's.js', claim: 'Wrapper class has a single caller and adds nothing' })]
  const afterFull = await run({ priorFindings: prior }, shared([], maint))
  assert.deepEqual(afterFull.result.carried.map(f => f.id), ['F-bbbbbb'])
  const afterLite = await run({ priorFindings: prior, priorFromLite: true }, shared([], maint))
  assert.deepEqual(afterLite.result.carried, [])
  assert.deepEqual(afterLite.result.findings.map(f => f.id), ['F-bbbbbb'])
})

test('suggestions and nits are capped at five shown each', async () => {
  const many = Array.from({ length: 7 }, (_, i) => finding({
    lens: 'simplification', file: `f${i}.js`, claim: `Helper number ${i} duplicates existing utility module${i}` }))
  const { result } = await run({}, shared([], many))
  assert.equal(result.findings.length, 5)
  assert.equal(result.collapsed.suggestion.length, 2)
  assert.equal(result.counts.suggestion, 7)
})

test('a reviewer that fails is reported as not run', async () => {
  const { result } = await run({}, label => (label === 'does-it-work' ? undefined : review([])))
  assert.deepEqual(result.counts.reviewersNotRun, ['does-it-work'])
  assert.equal(result.counts.reviewers, 1)
})

test('suppressed findings are counted, not raised', async () => {
  const { result, calls } = await run({ suppressions: [{ pattern: 'console.log in scripts/', reason: 'intended' }] },
    label => review([], { suppressed: [{ rule: 'console.log in scripts/', claim: 'debug output left in' }] }))
  assert.equal(result.counts.suppressed, 2)
  assert.ok(calls[0].prompt.includes('console.log in scripts/'))
})

test('suppressed entries that name no repo rule are not counted', async () => {
  const parked = () => review([], { suppressed: [{ rule: 'pre-existing pattern', claim: 'handler throws on null query' }] })
  assert.equal((await run({}, parked)).result.counts.suppressed, 0)
  assert.equal((await run({ suppressions: [{ pattern: 'console.log in scripts/' }] }, parked)).result.counts.suppressed, 0)
})

test('brief mode returns the drafted brief', async () => {
  const { result, labels } = await run({ mode: 'brief' }, () => ({ purpose: 'x' }))
  assert.deepEqual(labels, ['intent-brief'])
  assert.deepEqual(result, { mode: 'brief', ok: true, brief: { purpose: 'x' } })
  assert.equal((await run({ mode: 'brief' }, () => undefined)).result.ok, false)
})

test('image-check mode: six images per agent; only clean ones are publishable', async () => {
  const images = Array.from({ length: 8 }, (_, i) => ({ path: `/w/${i + 1}.png`, what: i === 0 ? 'orders page' : undefined }))
  const { result, labels, calls } = await run({ mode: 'image-check', images }, label => {
    if (label === 'images:1') return { images: [
      { number: 1, verdict: 'clean', details: 'placeholder data only' },
      { number: 2, verdict: 'sensitive', details: 'an email address in the header' },
      { number: 3, verdict: 'clean', details: '' }, { number: 4, verdict: 'clean', details: '' },
      { number: 5, verdict: 'clean', details: '' } // 6 missing
    ] }
    return undefined // the second batch fails
  })
  assert.deepEqual(labels, ['images:1', 'images:2'])
  assert.ok(calls[0].prompt.includes('1. /w/1.png — orders page') && calls[0].prompt.includes('6. /w/6.png'))
  assert.ok(calls[1].prompt.includes('7. /w/7.png') && !calls[1].prompt.includes('/w/6.png'))
  assert.deepEqual(result.images.map(i => i.publish), [true, false, true, true, true, false, false, false])
  assert.equal(result.withheld, 4)
})

test('verify mode: one verifier per finding, never shown the fix diff', async () => {
  const targets = [{ ...finding(), id: 'F-111111' }, { ...finding({ file: 'b.js' }), id: 'F-222222' }]
  const { result, calls } = await run({ mode: 'verify', findings: targets, fixDiffPath: '/work/fix.diff' }, label => {
    if (label === 'resolved:F-111111') return { verdict: 'resolved', evidence: '`exp * 1000`' }
    if (label === 'resolved:F-222222') return undefined
    return review([
      finding({ file: 'c.js', severity: 'important', claim: 'Fix drops the null guard on session' }),
      finding({ file: 'd.js', lens: 'simplification', claim: 'Fix could reuse the existing helper' })])
  })
  assert.deepEqual(result.resolution.map(r => r.verdict), ['resolved', 'unresolved'])
  assert.equal(result.resolution[1].verifierFailed, true)
  assert.deepEqual(result.introduced.map(f => f.file), ['c.js'])
  assert.equal(result.fixDiffReviewed, true)
  for (const c of calls.filter(c => c.label.startsWith('resolved'))) assert.ok(!c.prompt.includes('fix.diff'))
})
