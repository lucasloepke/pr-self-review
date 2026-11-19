// The eval scorer, against a small hand-made key.
const test = require('node:test')
const assert = require('node:assert/strict')
const { scoreReview, scoreBrief } = require('../eval/score.js')

const entry = {
  tier: 'Shared',
  areaTiers: { 'src/lib/p.js': 'Shared', 'src/r.js': 'Leaf' },
  unexplained: [{ id: 'U1', files: ['src/f.js', 'test/f.test.js'] }],
  defects: [
    { id: 'D1', locations: [{ file: 'src/r.js', lines: [1, 10] }], keywords: ['does not exist'], minSeverity: 'blocking' },
    { id: 'D2', locations: [{ file: 'src/r.js', lines: [1, 10] }], keywords: ['caught', 'silent'], minSeverity: 'important' },
    { id: 'D3', locations: [{ file: 'test/r.test.js' }], keywords: ['cannot fail'], minSeverity: 'important' }
  ],
  knownReal: [{ id: 'R1', locations: [{ file: 'test/r.test.js' }], keywords: ['no test'] }]
}
const f = (id, file, line, severity, claim) => ({ id, file, line, severity, claim })

test('caught, underrated, missed, rejected by skeptic, duplicates and noise', () => {
  const s = scoreReview(entry, {
    findings: [
      f('F-1', 'src/r.js', 5, 'blocking', 'Config file does not exist'),
      f('F-2', 'src/r.js', 6, 'suggestion', 'Error is caught and silently dropped'),
      f('F-3', 'src/r.js', 7, 'important', 'Loader reads a file that does not exist'),
      f('F-4', 'test/r.test.js', 3, 'important', 'Two criteria have no test'),
      f('F-5', 'src/other.js', 1, 'important', 'Unrelated claim')
    ],
    collapsed: { suggestion: [], nit: [] },
    rejected: [f('F-6', 'test/r.test.js', 2, 'important', 'This test cannot fail')]
  })
  const by = Object.fromEntries(s.perDefect.map(d => [d.id, d]))
  assert.equal(by.D1.outcome, 'caught')
  assert.equal(by.D1.duplicates, 1)
  assert.equal(by.D2.outcome, 'underrated')
  assert.equal(by.D3.outcome, 'rejected by skeptic')
  assert.equal(s.catchRate, 1 / 3)
  assert.equal(s.skepticLoss, 1)
  assert.deepEqual(s.knownRealFound, ['R1'])
  assert.deepEqual(s.extra.map(x => x.id), ['F-5'])
  assert.equal(s.seriousExtra, 1)
})

test('one finding is credited to one defect only', () => {
  const s = scoreReview(entry, { findings: [f('F-1', 'src/r.js', 5, 'blocking', 'File does not exist and the error is caught')] })
  assert.equal(s.perDefect.filter(d => d.outcome !== 'missed').length, 1)
})

test('brief: unexplained recall, PR tier and area tiers', () => {
  const s = scoreBrief(entry, { brief: {
    tiers: [{ area: 'src/lib/p.js, test/p.test.js', tier: 'Shared' }, { area: 'src/r.js', tier: 'Core' }],
    unexplained: [{ where: 'test/f.test.js', what: 'expectations changed' }, { where: 'src/x.js', what: 'y' }]
  } })
  assert.equal(s.unexplainedRecall, 1)
  assert.deepEqual(s.extraUnexplained, ['src/x.js'])
  assert.equal(s.prTier, 'Core')
  assert.equal(s.prTierCorrect, false)
  assert.equal(s.areaTiersCorrect, 1)
})
