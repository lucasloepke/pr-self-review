#!/usr/bin/env node
// Renders the PR comment from report-template.md's rules: fixed sections,
// closed status vocabulary, the verdict rule and the state block — in code, so
// none of it is written by hand.
//
//   node render-report.js <input.json> > report.md     (verdict on stderr)
//
// input.json:
// {
//   "skillVersion": "0.1.0", "date": "2026-11-18", "mode": "default" | "dont-stop", "dryRun": false,
//   "headSha": "…", "baseSha": "…", "tier": "Shared", "tierReason": "one line",
//   "brief": { confirmed brief },
//   "coverage": { "<acceptance criterion>": "covered" | "uncovered" },        optional
//   "checks": {                                    each { result, notes? }; label only for tests
//     "scope":      Pass | Fail
//     "tests":      Pass | Fail | Pending | Not run          + "label": "CI @ `abc1234`" or "local `npm test`"
//     "regression": Pass | Fail | Not run
//     "e2e":        Pass | Fail | Not run
//     "proof":      Provided | Not produced | Not required
//     "flagGate":   Pass | Fail | Not required
//   },
//   "proof": "markdown for the Proof section",                                  optional
//   "review": { the review workflow's result },
//   "decisions": { "F-…": { "status": "Fixed" | "Open" | "Open — needs author decision" | "Deferred"
//                           | "Declined" | "Pre-existing", "commit": "sha", "evidence": "…", "reason": "…" } },
//   "prior": { the previous state block },                                      optional (--update)
//   "keptUnexplained": ["…"], "notVerified": ["…"], "invalidAgents": ["label"]   optional
// }
'use strict'
const fs = require('fs')

const STATUSES = ['Fixed', 'Open', 'Open — needs author decision', 'Deferred', 'Declined', 'Pre-existing']
const RESULTS = {
  scope: ['Pass', 'Fail'],
  tests: ['Pass', 'Fail', 'Pending', 'Not run'],
  regression: ['Pass', 'Fail', 'Not run'],
  e2e: ['Pass', 'Fail', 'Not run'],
  proof: ['Provided', 'Not produced', 'Not required'],
  flagGate: ['Pass', 'Fail', 'Not required']
}
const RANK = { nit: 0, suggestion: 1, important: 2, blocking: 3 }
const SKEPTIC = { confirmed: 'Confirmed', reduced: 'Reduced', unproven: 'Unproven', skipped: '—' }

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const cell = s => String(s == null ? '' : s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
const short = (s, n) => { const t = cell(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const loc = f => `\`${f.file}${f.line ? `:${f.line}` : ''}\``
const ids = list => (list.length ? list.join(', ') : 'None')

function render(input) {
  const errors = []
  const review = input.review || {}
  const checks = input.checks || {}
  for (const [k, allowed] of Object.entries(RESULTS)) {
    const r = checks[k] && checks[k].result
    if (!allowed.includes(r)) errors.push(`checks.${k}.result must be one of ${allowed.join(' / ')}, got ${JSON.stringify(r)}`)
  }
  const decisions = input.decisions || {}
  for (const [id, d] of Object.entries(decisions)) {
    if (!STATUSES.includes(d.status)) errors.push(`decisions.${id}.status must be one of ${STATUSES.join(' / ')}, got ${JSON.stringify(d.status)}`)
  }
  if (errors.length) throw new Error(errors.join('\n'))

  // Every finding this report covers, with its final status.
  const priorById = Object.fromEntries(((input.prior && input.prior.findings) || []).map(f => [f.id, f]))
  const current = [...(review.findings || []), ...((review.collapsed && review.collapsed.suggestion) || []),
    ...((review.collapsed && review.collapsed.nit) || [])]
  const all = []
  for (const f of current) {
    const d = decisions[f.id] || {}
    all.push({ ...f, status: d.status || 'Open', commit: d.commit || '', evidence: d.evidence || '', reason: d.reason || '' })
  }
  for (const f of review.carried || []) {
    const p = priorById[f.id] || {}
    const d = decisions[f.id] || {}
    all.push({ ...f, status: d.status || baseStatus(p.status || f.priorStatus), commit: d.commit || p.commit || '',
      evidence: d.evidence || p.evidence || '', reason: d.reason || p.reason || '', carried: true })
  }
  all.sort((a, b) => RANK[b.severity] - RANK[a.severity])

  const serious = f => RANK[f.severity] >= RANK.important
  const isOpen = f => f.status.startsWith('Open')
  const fixed = f => f.status === 'Fixed'
  const testsRed = checks.tests.result === 'Fail'
  const reviewersNotRun = (review.counts && review.counts.reviewersNotRun) || []

  let verdict
  if (all.some(f => f.severity === 'blocking' && isOpen(f)) || testsRed) verdict = 'Not ready'
  else if (all.some(f => serious(f) && (isOpen(f) || f.status === 'Deferred' || f.status === 'Declined')) ||
    ['Pending', 'Not run'].includes(checks.tests.result) || checks.proof.result === 'Not produced' ||
    reviewersNotRun.length) verdict = 'Ready with open items'
  else verdict = 'Ready for review'

  const statusCell = f => {
    if (fixed(f)) {
      const where = f.commit ? `Fixed in \`${f.commit.slice(0, 7)}\`` : 'Fixed in working tree'
      return f.evidence ? `${where} — ${short(f.evidence, 140)}` : where
    }
    return f.reason ? `${f.status} — ${short(f.reason, 140)}` : f.status
  }

  const table = all.filter(f => serious(f) || fixed(f))
  const notTaken = all.filter(f => !serious(f) && !fixed(f))
  const brief = input.brief || {}
  const coverage = input.coverage || {}
  const c = review.counts || {}
  const reviewerCount = (review.reviewers || []).length
  const tally = s => all.filter(f => f.severity === s).length
  const disp = s => all.filter(f => (s === 'Open' ? isOpen(f) : f.status === s)).length

  const notVerified = [...(input.notVerified || [])]
  for (const [k, label] of [['regression', 'Regression vs base'], ['e2e', 'End-to-end'], ['tests', 'Tests']]) {
    if (checks[k].result === 'Not run') notVerified.push(`${label}: not run${checks[k].notes ? ` — ${checks[k].notes}` : ''}`)
  }
  if (checks.proof.result === 'Not produced') notVerified.push(`Proof: not produced${checks.proof.notes ? ` — ${checks.proof.notes}` : ''}`)
  for (const r of reviewersNotRun) notVerified.push(`Reviewer \`${r}\` did not return; its lenses were not covered.`)
  for (const a of input.invalidAgents || []) notVerified.push(`Agent \`${a}\` returned an unreadable answer and counts as not run.`)

  const secondOpinion = [
    ...all.filter(f => f.severity === 'blocking' && (f.status === 'Deferred' || f.status === 'Declined')),
    ...all.filter(f => f.severity !== 'blocking' && f.status === 'Declined')
  ].map(f => f.id)

  const lines = []
  const out = s => lines.push(s)
  out('<!-- pr-self-review -->')
  out('## Self-review report')
  out('')
  out(`**Verdict:** ${verdict}`)
  out(`**Reviewed:** \`${(input.headSha || '').slice(0, 7)}\` (base \`${(input.baseSha || '').slice(0, 7)}\`) · ${input.date} · ${input.mode === 'dont-stop' ? "don't-stop" : 'default'} mode · skill v${input.skillVersion}${input.dryRun ? ' · dry run' : ''}`)
  out('')
  out('### Intent')
  out(`**Purpose:** ${cell(brief.purpose)}`)
  out('**Acceptance criteria:**')
  for (const a of brief.acceptance || []) out(`- ${cell(a)} — ${coverage[a] || 'not checked'}`)
  if (!(brief.acceptance || []).length) out('None')
  out(`**Out of scope:** ${(brief.outOfScope || []).length ? brief.outOfScope.map(cell).join('; ') : 'None'}`)
  out(`**Review depth:** ${input.tier} — ${cell(input.tierReason)}`)
  out('')
  out('### Checks')
  out('| Check | Result | Notes |')
  out('|---|---|---|')
  const row = (name, k) => out(`| ${name} | ${checks[k].result} | ${cell(checks[k].notes)} |`)
  row('Scope matches description', 'scope')
  out(`| Tests (${checks.tests.label || 'not run'}) | ${checks.tests.result} | ${cell(checks.tests.notes)} |`)
  row('Regression vs base', 'regression')
  row('End-to-end', 'e2e')
  out(`| Review | ${reviewerCount} reviewers, ${c.raised || 0} raised, ${c.confirmed || 0} confirmed, ${c.rejected || 0} rejected, ${c.suppressed || 0} suppressed | ${reviewersNotRun.length ? `not run: ${reviewersNotRun.join(', ')}` : ''} |`)
  row('Proof', 'proof')
  row('Feature-flag gating', 'flagGate')
  out('')
  out('### Proof')
  out(input.proof ? input.proof : 'None')
  out('')
  if (input.prior) {
    const priorIds = Object.keys(priorById)
    const byId = Object.fromEntries(all.map(f => [f.id, f]))
    out('### Changes since the last run')
    out(`- Resolved: ${ids(priorIds.filter(id => byId[id] && fixed(byId[id]) && priorById[id].status && !/^Fixed/.test(priorById[id].status)))}`)
    out(`- Carried over: ${ids(priorIds.filter(id => byId[id] && isOpen(byId[id])).map(id => `${id}${byId[id].reason ? ` (${short(byId[id].reason, 80)})` : ''}`))}`)
    out(`- Newly raised: ${ids(all.filter(f => !priorById[f.id]).map(f => f.id))}`)
    out('')
  }
  out('### Findings')
  if (table.length) {
    out('| ID | Severity | Location | Issue | Skeptic | Status |')
    out('|---|---|---|---|---|---|')
    for (const f of table) out(`| ${f.id} | ${cap(f.severity)} | ${loc(f)} | ${cell(f.claim)} | ${SKEPTIC[f.skeptic] || '—'} | ${statusCell(f)} |`)
  } else {
    out('No blocking or important findings.')
  }
  out('')
  out(`**Totals:** ${tally('blocking')} blocking · ${tally('important')} important · ${tally('suggestion')} suggestion · ${tally('nit')} nit —`)
  out(`${disp('Fixed')} fixed · ${disp('Open')} open · ${disp('Deferred')} deferred · ${disp('Declined')} declined`)
  out('')
  out('### Rejected by the skeptic')
  if ((review.rejected || []).length) {
    out('| ID | Raised as | Location | Why rejected |')
    out('|---|---|---|---|')
    for (const f of review.rejected) out(`| ${f.id} | ${cap(f.severity)} | ${loc(f)} | ${short(f.skepticReason, 200)} |`)
  } else {
    out('None')
  }
  out('')
  out('### Not verified')
  out(notVerified.length ? notVerified.map(n => `- ${cell(n)}`).join('\n') : 'None')
  out('')
  out('### Notes for the reviewer')
  const look = [...new Set(all.filter(serious).map(f => f.file))]
  out(`**Where to look first:** ${look.length ? look.map(f => `\`${f}\``).join(', ') : 'None'}`)
  out(`**Decisions worth a second opinion:** ${ids(secondOpinion)}`)
  out(`**Changes beyond the description:** ${(input.keptUnexplained || []).length ? input.keptUnexplained.map(cell).join('; ') : 'None'}`)
  out(`<details><summary>Suggestions and nits not taken (${notTaken.length})</summary>`)
  out('')
  out(notTaken.length ? notTaken.map(f => `- ${f.id} · ${cap(f.severity)} · ${loc(f)} — ${cell(f.claim)}`).join('\n') : 'None')
  out('')
  out('</details>')
  out('')

  const state = {
    reviewedSha: input.headSha, baseSha: input.baseSha, mode: input.mode, tier: input.tier, skill: input.skillVersion,
    brief, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.result])),
    findings: all.map(f => ({
      id: f.id, file: f.file, line: f.line, lens: f.lens, severity: f.severity, claim: f.claim,
      intended: f.intended, observed: f.observed, failureCase: f.failureCase, skeptic: f.skeptic,
      status: fixed(f) ? (f.commit ? `Fixed in ${f.commit}` : 'Fixed') : f.status,
      commit: f.commit || undefined, evidence: f.evidence || undefined, reason: f.reason || undefined
    })),
    rejected: (review.rejected || []).map(f => ({ id: f.id, file: f.file, line: f.line, severity: f.severity, claim: f.claim, reason: f.skepticReason }))
  }
  out('<!-- pr-self-review:state v1')
  out(JSON.stringify(state).replace(/>/g, '\\u003e'))
  out('-->')
  return { markdown: `${lines.join('\n')}\n`, verdict }
}

// A prior state's status ("Fixed in abc", "Deferred") → the closed vocabulary.
function baseStatus(s) {
  const t = String(s || 'Open')
  if (/^Fixed/.test(t)) return 'Fixed'
  return STATUSES.find(v => v === t) || (t.startsWith('Open') ? 'Open' : 'Open')
}

module.exports = { render }

if (require.main === module) {
  const file = process.argv[2]
  if (!file) { process.stderr.write('usage: render-report.js <input.json>\n'); process.exit(1) }
  try {
    const { markdown, verdict } = render(JSON.parse(fs.readFileSync(file, 'utf8')))
    process.stdout.write(markdown)
    process.stderr.write(`verdict: ${verdict}\n`)
  } catch (e) {
    process.stderr.write(`render-report: ${e.message}\n`)
    process.exit(1)
  }
}
