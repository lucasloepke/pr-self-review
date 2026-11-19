#!/usr/bin/env node
// Scores self-review runs on one fixture branch against eval/expected.json.
//
//   node eval/score.js <branch> [--review <result.json>]... [--brief <result.json>]...
//                      [--skeptic <result.json>]... [--key <expected.json>]
//
//   --review   the review workflow's result (mode "review")
//   --brief    the workflow's result in mode "brief"
//   --skeptic  a review result produced from the branch's plantedFalse findings
//
// Prints per-run scores and, across runs, mean / min / max.
'use strict'
const fs = require('fs')
const path = require('path')

const RANK = { nit: 0, suggestion: 1, important: 2, blocking: 3 }
const TIER = { Inert: 0, Leaf: 1, Shared: 2, Core: 3 }

function matches(defect, f) {
  const atLocation = defect.locations.some(l => f.file === l.file &&
    (!l.lines || f.line == null || (f.line >= l.lines[0] && f.line <= l.lines[1])))
  const claim = String(f.claim || '').toLowerCase()
  return atLocation && defect.keywords.some(k => claim.includes(k.toLowerCase()))
}

// Credit each finding to one defect at most, most constrained defect first.
function assign(defects, findings) {
  const candidates = defects.map(d => ({ d, fs: findings.filter(f => matches(d, f)) }))
  const used = new Set()
  const credit = {}
  for (const { d, fs: cands } of [...candidates].sort((a, b) => a.fs.length - b.fs.length)) {
    const best = cands.filter(f => !used.has(f.id)).sort((a, b) => RANK[b.severity] - RANK[a.severity])[0]
    if (best) used.add(best.id)
    credit[d.id] = { finding: best || null, all: cands }
  }
  return { credit, used }
}

function scoreReview(entry, result) {
  const kept = [...(result.findings || []), ...((result.collapsed && result.collapsed.suggestion) || []),
    ...((result.collapsed && result.collapsed.nit) || []), ...(result.carried || [])]
  const rejected = result.rejected || []
  const { credit, used } = assign(entry.defects, kept)
  const rejectedCredit = assign(entry.defects, rejected).credit
  const perDefect = entry.defects.map(d => {
    const c = credit[d.id]
    let outcome = 'missed'
    if (c.finding) outcome = RANK[c.finding.severity] >= RANK[d.minSeverity] ? 'caught' : 'underrated'
    else if (rejectedCredit[d.id].finding) outcome = 'rejected by skeptic'
    return { id: d.id, outcome, by: c.finding ? c.finding.id : null, severity: c.finding ? c.finding.severity : null,
      duplicates: Math.max(0, c.all.length - 1) }
  })
  const knownReal = entry.knownReal || []
  const realFound = knownReal.filter(r => kept.some(f => matches(r, f))).map(r => r.id)
  const extra = kept.filter(f => !used.has(f.id) && !entry.defects.some(d => matches(d, f)) && !knownReal.some(r => matches(r, f)))
  return {
    knownRealFound: realFound,
    caught: perDefect.filter(d => d.outcome === 'caught').length,
    planted: entry.defects.length,
    catchRate: entry.defects.length ? perDefect.filter(d => d.outcome === 'caught').length / entry.defects.length : null,
    skepticLoss: perDefect.filter(d => d.outcome === 'rejected by skeptic').length,
    duplicates: perDefect.reduce((n, d) => n + d.duplicates, 0),
    seriousExtra: extra.filter(f => RANK[f.severity] >= RANK.important).length,
    extra: extra.map(f => ({ id: f.id, severity: f.severity, file: f.file, claim: f.claim })),
    perDefect
  }
}

function scoreBrief(entry, result) {
  const brief = result.brief || {}
  const items = brief.unexplained || []
  const mentions = (u, files) => files.some(file => `${u.where} ${u.what}`.includes(file))
  const found = entry.unexplained.filter(e => items.some(u => mentions(u, e.files))).map(e => e.id)
  const tiers = brief.tiers || []
  const prTier = tiers.reduce((t, a) => (TIER[a.tier] > TIER[t] ? a.tier : t), 'Inert')
  const areaTier = file => (tiers.find(a => a.area.split(/,\s*/).includes(file)) || {}).tier || null
  const areas = Object.entries(entry.areaTiers || {}).map(([file, want]) => ({ file, want, got: areaTier(file) }))
  return {
    unexplainedRecall: entry.unexplained.length ? found.length / entry.unexplained.length : null,
    missedUnexplained: entry.unexplained.filter(e => !found.includes(e.id)).map(e => e.id),
    extraUnexplained: items.filter(u => !entry.unexplained.some(e => mentions(u, e.files))).map(u => u.where),
    prTier, prTierCorrect: prTier === entry.tier,
    areaTiersCorrect: areas.filter(a => a.got === a.want).length, areaTiersChecked: areas.length,
    areas
  }
}

function scoreSkeptic(entry, result) {
  const planted = entry.plantedFalse || []
  const rejected = (result.rejected || []).length
  return { planted: planted.length, rejected, kept: (result.findings || []).length }
}

const spread = xs => {
  const v = xs.filter(x => typeof x === 'number')
  if (!v.length) return null
  return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), min: Math.min(...v), max: Math.max(...v), n: v.length }
}

function main(argv) {
  const branch = argv[0]
  const opt = { review: [], brief: [], skeptic: [], key: path.join(__dirname, 'expected.json') }
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '')
    if (!(k in opt)) throw new Error(`unknown option ${argv[i]}`)
    if (Array.isArray(opt[k])) opt[k].push(argv[i + 1]); else opt[k] = argv[i + 1]
  }
  const entry = JSON.parse(fs.readFileSync(opt.key, 'utf8')).branches[branch]
  if (!entry) throw new Error(`no branch ${branch} in the key`)
  const load = p => JSON.parse(fs.readFileSync(p, 'utf8'))
  const reviews = opt.review.map(p => scoreReview(entry, load(p)))
  const briefs = opt.brief.map(p => scoreBrief(entry, load(p)))
  const skeptics = opt.skeptic.map(p => scoreSkeptic(entry, load(p)))
  return {
    branch,
    summary: {
      catchRate: spread(reviews.map(r => r.catchRate)),
      skepticLoss: spread(reviews.map(r => r.skepticLoss)),
      duplicates: spread(reviews.map(r => r.duplicates)),
      seriousExtra: spread(reviews.map(r => r.seriousExtra)),
      unexplainedRecall: spread(briefs.map(b => b.unexplainedRecall)),
      prTierCorrect: spread(briefs.map(b => (b.prTierCorrect ? 1 : 0))),
      plantedFalseRejected: spread(skeptics.map(s => (s.planted ? s.rejected / s.planted : null)))
    },
    reviews, briefs, skeptics
  }
}

module.exports = { main, scoreReview, scoreBrief }

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`score: ${e.message}\n`)
    process.exit(1)
  }
}
