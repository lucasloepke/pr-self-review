// pr-self-review workflow
//
// One script, three modes. Every agent it starts is fresh: it receives a fixed
// prompt plus artifacts (files in workDir, the confirmed brief, the repo) and
// nothing from the session that launched the workflow.
//
//   mode "brief"   one agent drafts the intent brief
//   mode "review"  reviewers in parallel, then one skeptic per serious finding
//   mode "verify"  one agent per fixed finding ("resolved?"), plus one agent
//                  reading the combined fix diff ("broke anything?")
//
// Severity ceilings, de-duplication, finding ids, prior-decision matching and
// the Suggestion/Nit caps are applied here in code, never by a model.
//
// args (all modes):
//   mode       "brief" | "review" | "verify"
//   repoRoot   absolute path of the checkout under review
//   workDir    absolute path of the folder written by scripts/gather.sh
//   skillDir   absolute path of this skill's folder
//
// args (review):
//   brief           the confirmed intent brief (object)
//   tier            "Core" | "Shared" | "Leaf" | "Inert"  (PR-level; default "Shared")
//   changedLines    number of changed lines (Core diffs of 400+ split further)
//   dontStop        true → Suggestions also go through the skeptic
//   scopeNote       optional sentence, e.g. "The diffs hold only hunks added since <sha>."
//   conventions     optional string[] of repo-relative convention files
//   leads           optional string[] of files in workDir holding scanner / test output
//   suppressions    optional [{ pattern, reason }]
//   priorFindings   optional findings[] from the PR's state block
//
// args (verify):
//   findings        findings to re-check (id, file, line, claim, intended, observed, failureCase)
//   fixDiffPath     optional absolute path of the combined fix diff
//
// args (image-check):
//   images          [{ path, what }] — absolute paths of screenshots about to be published

export const meta = {
  name: 'pr-self-review',
  description: 'Intent brief, partitioned reviewers with a per-finding skeptic, and fresh-agent fix verification for a PR self-review',
  phases: [
    { title: 'Brief', detail: 'Draft the intent brief' },
    { title: 'Review', detail: 'Reviewers in parallel over the partitioned diff' },
    { title: 'Skeptic', detail: 'One skeptic per Blocking / Important finding' },
    { title: 'Verify fixes', detail: 'Fresh agent per fixed finding' },
    { title: 'Image check', detail: 'Fresh agent per screenshot, before it is published' }
  ]
}

const A = args || {}
const mode = A.mode || 'review'
const repoRoot = A.repoRoot
const workDir = A.workDir
const skillDir = A.skillDir

// ---------------------------------------------------------------------------
// Fixed vocabulary
// ---------------------------------------------------------------------------

const RANK = { nit: 0, suggestion: 1, important: 2, blocking: 3 }
const SEVERITIES = ['blocking', 'important', 'suggestion', 'nit']

// Highest severity each lens may reach, whatever the agent returns.
const CEILING = {
  'correctness': 'blocking',
  'error-handling': 'blocking',
  'callers': 'blocking',
  'tests': 'important',
  'ai-failure-modes': 'important',
  'types': 'important',
  'comments': 'important',
  'simplification': 'suggestion',
  'style': 'nit'
}
const LENSES = Object.keys(CEILING)

const LENS_BRIEF = {
  'correctness': 'Correctness and security — wrong logic, unhandled empty or missing values, boundary errors, concurrency and ordering faults, leaked resources, injection and authorisation holes.',
  'error-handling': 'Error handling — failures that are caught and hidden, fallbacks that mask a problem without a trace, errors that leave data half-written.',
  'callers': 'Impact on callers — look up every function, export, endpoint, type or config key the diff changes or removes across the repo. Report callers whose behaviour shifts (cite the caller\'s file and line in "observed"); do not report unaffected callers. Includes compatibility: public API, schema, migration, config or env changes with no migration path.',
  'tests': 'Test adequacy — for each acceptance criterion in the brief, name the test that would fail if it broke, or report it uncovered; branches and error paths with no test; tests that cannot fail. Also deleted, skipped or loosened tests and assertions, lowered coverage thresholds, disabled lint rules.',
  'ai-failure-modes': `AI-code failure modes — work through the checklist in ${skillDir}/ai-failure-modes.md (read it first).`,
  'types': 'Data model and types — only when they change: states that should be impossible but are now representable, internals exposed to callers, types widened to silence an error.',
  'comments': 'Comments and docs — comments and docstrings near the change that no longer describe the code. Missing comments are not findings.',
  'simplification': 'Simplification — abstraction with a single use, generality nobody asked for, dead code. For the failure case, state the concrete maintenance cost.',
  'style': 'Style — only a clear break with a convention written down in the repo. Never personal preference.'
}

const WORKS = ['correctness', 'error-handling', 'callers']
const MAINTAINABLE = ['tests', 'ai-failure-modes', 'types', 'comments', 'simplification', 'style']

// Which reviewers run for a PR-level tier. `tests: true` → also receives test.diff.
function planReviewers(tier, changedLines) {
  if (tier === 'Inert') return []
  if (tier === 'Leaf') {
    return [{ name: 'all-lenses', lenses: [...WORKS, ...MAINTAINABLE], tests: true }]
  }
  if (tier === 'Core') {
    const plan = [
      { name: 'correctness', lenses: ['correctness', 'error-handling'], tests: false },
      { name: 'callers', lenses: ['callers'], tests: false },
      { name: 'security-compatibility', lenses: ['correctness', 'callers'], tests: false,
        focus: 'Your whole attention goes to two things: security (authentication, authorisation, injection, secrets, unsafe input handling) and compatibility (public API, schema and migrations, config and env keys, stored data written by the old code). Leave general logic bugs to the other reviewers.' }
    ]
    if ((changedLines || 0) >= 400) {
      plan.push({ name: 'tests', lenses: ['tests'], tests: true })
      plan.push({ name: 'maintainability', lenses: MAINTAINABLE.filter(l => l !== 'tests'), tests: true })
    } else {
      plan.push({ name: 'honest-and-maintainable', lenses: MAINTAINABLE, tests: true })
    }
    return plan
  }
  return [
    { name: 'does-it-work', lenses: WORKS, tests: false },
    { name: 'honest-and-maintainable', lenses: MAINTAINABLE, tests: true }
  ]
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FINDING_ITEM = {
  type: 'object',
  properties: {
    lens: { type: 'string', enum: LENSES },
    severity: { type: 'string', enum: SEVERITIES },
    file: { type: 'string', description: 'Repo-relative path' },
    line: { type: 'number' },
    claim: { type: 'string', description: 'One sentence stating the defect' },
    intended: { type: 'string', description: 'What the brief says this code should do' },
    observed: { type: 'string', description: 'The current code, quoted' },
    failureCase: { type: 'string', description: 'A concrete input or state that goes wrong, and what happens' },
    fix: { type: 'string', description: 'The smallest change that would resolve it' },
    needsDecision: { type: 'boolean', description: 'true when the fix needs a product or design choice' }
  },
  required: ['lens', 'severity', 'file', 'claim', 'intended', 'observed', 'failureCase']
}

const SUPPRESSION_RULES = (A.suppressions || []).map(s => (typeof s.pattern === 'string' ? s.pattern.trim() : '')).filter(Boolean)

// `suppressed` exists only when the repo has rules; otherwise reviewers use it
// to park findings they talked themselves out of.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    attacksTried: {
      type: 'array', items: { type: 'string' },
      description: 'The specific attacks attempted, including the ones that found nothing'
    },
    findings: { type: 'array', items: FINDING_ITEM },
    ...(SUPPRESSION_RULES.length ? {
      suppressed: {
        type: 'array',
        description: 'Only findings that match one of the repo suppression rules; rule is that rule, copied exactly',
        items: {
          type: 'object',
          properties: { rule: { type: 'string', enum: SUPPRESSION_RULES }, file: { type: 'string' }, claim: { type: 'string' } },
          required: ['rule', 'claim']
        }
      }
    } : {})
  },
  required: ['attacksTried', 'findings']
}

const SKEPTIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'rejected', 'reduced', 'unproven'] },
    reason: { type: 'string' },
    newSeverity: { type: 'string', enum: SEVERITIES }
  },
  required: ['verdict', 'reason']
}

const RESOLVED_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['resolved', 'partial', 'unresolved'] },
    evidence: { type: 'string', description: 'Quoted current code that settles it' },
    remaining: { type: 'string', description: 'For partial / unresolved: what still fails' }
  },
  required: ['verdict', 'evidence']
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    purpose: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    tiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'A path or group of paths' },
          tier: { type: 'string', enum: ['Core', 'Shared', 'Leaf', 'Inert'] },
          kind: { type: 'string', enum: ['visual', 'behaviour', 'api-cli', 'performance', 'refactor', 'inert'] },
          reason: { type: 'string' }
        },
        required: ['area', 'tier', 'kind', 'reason']
      }
    },
    unexplained: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, what: { type: 'string' } },
        required: ['where', 'what']
      }
    },
    description: { type: 'string', enum: ['sufficient', 'needs writing'] },
    flagGate: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        flag: { type: 'string' },
        source: { type: 'string', description: 'The sentence in the ticket or PR body that asks for gating' }
      },
      required: ['required']
    }
  },
  required: ['purpose', 'acceptance', 'outOfScope', 'tiers', 'unexplained', 'description', 'flagGate']
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const text = v => (typeof v === 'string' ? v.trim() : '')
const words = s => text(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2)

// Share of words two claims have in common (Jaccard). Wording varies between
// agents and runs, so "same claim" means mostly the same words, not equality.
const stem = w => w.replace(/(ing|ed|es|s)$/, '')
function similarity(a, b) {
  const x = new Set(words(a).map(stem)), y = new Set(words(b).map(stem))
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}
const sameClaim = (a, b) => similarity(a, b) >= 0.5
// Two reviewers describing one defect word it differently but quote the same
// code. Mostly the same quote plus some shared wording is the same finding.
const sameDefect = (a, b) => sameClaim(a.claim, b.claim) ||
  (similarity(a.observed, b.observed) >= 0.7 && similarity(a.claim, b.claim) >= 0.25)

function hash6(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}
const findingId = f => `F-${hash6(`${f.file}|${words(f.claim).join(' ')}`)}`

const bySeverity = (a, b) => RANK[b.severity] - RANK[a.severity]

// Drop incomplete findings, apply lens ceilings.
function normalise(raw, reviewer, discarded) {
  const out = []
  for (const r of raw || []) {
    const f = {
      lens: LENSES.includes(r.lens) ? r.lens : null,
      severity: text(r.severity).toLowerCase(),
      file: text(r.file),
      line: Number.isFinite(r.line) ? r.line : null,
      claim: text(r.claim),
      intended: text(r.intended),
      observed: text(r.observed),
      failureCase: text(r.failureCase),
      fix: text(r.fix),
      needsDecision: r.needsDecision === true,
      reviewer
    }
    const missing = ['lens', 'file', 'claim', 'intended', 'observed', 'failureCase'].filter(k => !f[k])
    if (!(f.severity in RANK)) missing.push('severity')
    if (missing.length) {
      discarded.push({ reviewer, file: f.file, claim: f.claim, why: `missing ${missing.join(', ')}` })
      continue
    }
    f.raisedAs = f.severity
    const ceiling = CEILING[f.lens]
    if (RANK[f.severity] > RANK[ceiling]) { f.severity = ceiling; f.capped = true }
    out.push(f)
  }
  return out
}

// Same file, nearby line, same claim → one finding, highest severity wins.
function dedupe(findings) {
  const out = []
  for (const f of findings) {
    const dup = out.find(d =>
      d.file === f.file &&
      (d.line === null || f.line === null || Math.abs(d.line - f.line) <= 3) &&
      sameDefect(d, f))
    if (!dup) { out.push({ ...f }); continue }
    const raisers = new Set([...(dup.alsoRaisedBy || []), dup.reviewer, f.reviewer])
    if (RANK[f.severity] > RANK[dup.severity]) Object.assign(dup, f)
    raisers.delete(dup.reviewer)
    if (raisers.size) dup.alsoRaisedBy = [...raisers]
  }
  return out
}

function assignIds(findings, prior) {
  const used = new Set()
  for (const f of findings) {
    // Lines move between runs, so a prior finding matches on file and claim only.
    const match = (prior || []).find(p => p.id && !used.has(p.id) && p.file === f.file && sameClaim(p.claim, f.claim))
    let id = match ? match.id : findingId(f)
    for (let n = 2; used.has(id); n++) id = `${match ? match.id : findingId(f)}-${n}`
    used.add(id)
    f.id = id
    if (match) { f.priorStatus = text(match.status); f.priorSeverity = text(match.severity).toLowerCase() }
  }
  return findings
}

// A finding the author already decided, or a Suggestion / Nit already raised
// once, is not raised again.
function alreadyDecided(f) {
  if (f.priorStatus === undefined) return false
  if (/^(deferred|declined|pre-existing)/i.test(f.priorStatus)) return true
  return f.priorSeverity === 'suggestion' || f.priorSeverity === 'nit'
}

const settled = results => (Array.isArray(results) ? results : [])

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const READ_ONLY = `Repository root: ${repoRoot}
Read and search it freely. Do not edit, create or delete files, and do not run commands that change the repo or its git state.`

function briefPrompt() {
  return `You are drafting the intent brief for a pull request: a statement of what the PR is meant to do, which a later review will be judged against. You are not reviewing the code.

${READ_ONLY}

Read these files in ${workDir} (skip any that do not exist):
- pr.json — PR title and body
- commits.txt — commit messages
- issue.json — the linked issue or ticket
- diffstat.txt and files-prod.txt, files-test.txt — what changed
- full.diff — consult it wherever the description leaves a file unexplained
- conventions.txt — repo convention files worth reading
- classify.json — a first guess at each file's tier and kind from paths and import counts

Produce:
- purpose: what the PR is for, in one sentence.
- acceptance: acceptance criteria — statements that can be checked against the running code. Specific and testable; no restating of the diff.
- outOfScope: what the PR is meant to leave alone.
- tiers: each changed area with its review tier, change kind and the reason.
    Core — infrastructure, auth, data layer and migrations, build/deploy config, payments, and a public API: one published to consumers outside this repo (a library's exported interface, a versioned API that other services or customers call). An ordinary route or handler inside the app is not Core for that reason alone.
    Shared — utilities, hooks, shared components, anything imported from several places (search for importers; high fan-in is Shared at least, whatever the folder is called).
    Leaf — presentational components, copy, styling, a single screen or route.
    Inert — docs, comments, non-shipping config. Tests are never Inert: a test file takes the tier of the code it tests.
    Start from classify.json when it exists. Where you choose a different tier or kind, the reason must say what the guess missed. Entries marked "binding" come from the repo's config and stand as given. When unsure, choose the higher tier.
- unexplained: files or hunks that nothing in the title, body, commits or ticket accounts for. Leave empty when everything is accounted for.
- description: "sufficient", or "needs writing" when the PR body is empty or too vague to review against.
- flagGate: required=true ONLY when the ticket or PR body itself asks for the work to be behind a feature flag ("behind a flag", "gated by <flag>", "dark launch", a named flag). Quote that sentence in source and name the flag if one is named. Otherwise required=false. A change merely lacking a flag is not a reason.

Work only from those artifacts and the repo. Where the artifacts do not say, do not invent intent: keep acceptance to what is stated or plainly implied, and list the rest under unexplained.`
}

function sharedContext() {
  const parts = [
    READ_ONLY,
    `CONFIRMED INTENT BRIEF (confirmed by the author — it defines what the code is meant to do):
${JSON.stringify(A.brief || {}, null, 2)}`,
    `Each area's review tier is in the brief's "tiers". Core: read whole files, not just hunks, and trace every caller. Shared: check every call site of a changed signature or behaviour. Leaf: a light read.`
  ]
  if (A.scopeNote) parts.push(text(A.scopeNote))
  if ((A.conventions || []).length) parts.push(`Repo conventions to hold the change to: ${A.conventions.join(', ')} (repo-relative; read them).`)
  if ((A.leads || []).length) parts.push(`Tool output that may contain leads (verify anything you take from it): ${A.leads.map(l => `${workDir}/${l}`).join(', ')}`)
  if ((A.suppressions || []).length) {
    parts.push(`REPO SUPPRESSION RULES — a finding that matches one of these is not raised; return it under "suppressed" with the rule it matched. Suppression never applies to a Blocking finding.
${A.suppressions.map(s => `- ${s.pattern}${s.reason ? ` (${s.reason})` : ''}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

function reviewerPrompt(r) {
  const diffs = r.tests
    ? `Your partition of the diff: ${workDir}/prod.diff (production code) and ${workDir}/test.diff (tests). Read both in full before anything else.`
    : `Your partition of the diff: ${workDir}/prod.diff (production code). Read it in full before anything else. Test changes are reviewed by someone else.`
  return `You are one of several independent reviewers of a pull request, working for its author before a human reviews it. You have not seen the others' work.

${sharedContext()}

${diffs}

YOUR LENSES — report only through these:
${r.lenses.map(l => `- [${l}] ${LENS_BRIEF[l]}`).join('\n')}
${r.focus ? `\n${r.focus}\n` : ''}
HUNT HARD. Actively try to break the change: construct inputs, states, orderings and failure conditions; read callers and surrounding code, not only the diff; treat the PR description and the brief's acceptance criteria as claims to test against the code.

REPORT STRICTLY. A finding is:
- intended — what the brief says this code should do;
- observed — the current code, quoted;
- failureCase — a concrete input or state that goes wrong, and what happens.
If you cannot give all three, it is not a finding; leave it out.
Severity: blocking = breaks stated intent, a regression, data loss or a security hole. important = a real defect or risk, but narrow or with a workaround. suggestion = an improvement with a clear benefit, safe to defer. nit = style or naming with no behavioural effect.
Set needsDecision when the right fix depends on a product or design choice the brief does not settle.

An empty findings list is a valid and expected result. Nothing here says a defect exists. Report what you can demonstrate — no more, no fewer.

Whatever you find, list under attacksTried the specific attacks you attempted, including each one that failed to break anything ("null id passed to loadUser — guarded at users.ts:41").`
}

function skepticPrompt(f) {
  return `A reviewer raised the finding below against a pull request. Your job is to test whether it is true, by trying to disprove it.

${READ_ONLY}
Where it is safe and quick, reproduce the failure case (an existing test command, a one-off script outside the repo); otherwise settle it by reading the code.

FINDING ${f.id}
- Location: ${f.file}${f.line ? `:${f.line}` : ''}
- Severity claimed: ${f.severity}
- Claim: ${f.claim}
- Intended: ${f.intended}
- Observed: ${f.observed}
- Failure case: ${f.failureCase}

Read the code at and around that location; trace callers and callees as far as the failure case needs.

Return one verdict:
- confirmed — the failure case happens. Show the code path that fails.
- rejected — the failure case cannot occur. Show exactly why (guarded elsewhere, unreachable, input cannot take that value, the brief's intent is different from what the finding assumes).
- reduced — real, but less severe than claimed. Set newSeverity and say why.
- unproven — the code alone cannot settle it. Say what would.
Give the evidence for your verdict as quoted code with file and line. Do not guess in either direction.`
}

function resolvedPrompt(f) {
  return `A finding was raised against this code earlier, and a fix may have been made since. Decide whether the finding is resolved in the code as it stands now.

${READ_ONLY}
Judge the current file contents only. Do not consult git history, diffs or commit messages.

FINDING ${f.id}
- Location when raised: ${f.file}${f.line ? `:${f.line}` : ''}
- Claim: ${f.claim}
- Intended: ${f.intended}
- Observed when raised: ${f.observed}
- Failure case: ${f.failureCase}

If the code has moved, find where it went — a line having disappeared proves nothing on its own.

Return one verdict:
- resolved — quote the code that fixes it and say why the failure case no longer happens.
- partial — say which part of the failure case still goes wrong (remaining).
- unresolved — quote the code showing the problem is still there.`
}

function fixDiffPrompt() {
  return `The diff at ${A.fixDiffPath} is a set of small fixes made to a pull request in response to review findings. Read it in full. Your only question: did these fixes introduce a new defect?

${sharedContext()}

Report a finding only when a fix itself breaks something — wrong logic, a hidden failure, a caller whose behaviour shifts — at blocking or important severity. Each finding needs intended, observed (quoted code) and failureCase (a concrete input or state that goes wrong). Do not re-review the rest of the pull request and do not report suggestions or style.

An empty findings list is a valid and expected result. List under attacksTried what you checked.`
}

// ---------------------------------------------------------------------------
// Mode: brief
// ---------------------------------------------------------------------------

if (mode === 'brief') {
  phase('Brief')
  const brief = await agent(briefPrompt(), { label: 'intent-brief', phase: 'Brief', agentType: 'general-purpose', schema: BRIEF_SCHEMA })
  if (!brief) return { mode, ok: false, error: 'The brief agent returned nothing.' }
  return { mode, ok: true, brief }
}

// ---------------------------------------------------------------------------
// Mode: verify
// ---------------------------------------------------------------------------

if (mode === 'verify') {
  phase('Verify fixes')
  const targets = A.findings || []
  log(`Checking ${targets.length} finding(s) against the current code...`)

  const jobs = targets.map(f => () => agent(resolvedPrompt(f),
    { label: `resolved:${f.id}`, phase: 'Verify fixes', agentType: 'general-purpose', schema: RESOLVED_SCHEMA }))
  if (A.fixDiffPath) {
    jobs.push(() => agent(fixDiffPrompt(),
      { label: 'fix-diff', phase: 'Verify fixes', agentType: 'general-purpose', schema: REVIEW_SCHEMA }))
  }
  const results = settled(await parallel(jobs))

  const resolution = targets.map((f, i) => {
    const r = results[i]
    // No answer is not evidence of a fix.
    if (!r) return { id: f.id, verdict: 'unresolved', evidence: '', remaining: 'The verifier did not return; not verified.', verifierFailed: true }
    return { id: f.id, verdict: r.verdict, evidence: text(r.evidence), remaining: text(r.remaining) }
  })

  let introduced = []
  let fixDiffReviewed = null
  if (A.fixDiffPath) {
    const r = results[targets.length]
    fixDiffReviewed = Boolean(r)
    const discarded = []
    introduced = normalise(r && r.findings, 'fix-diff', discarded).filter(f => RANK[f.severity] >= RANK.important)
    introduced = assignIds(dedupe(introduced), []).sort(bySeverity)
  }

  return { mode, resolution, introduced, fixDiffReviewed }
}

// ---------------------------------------------------------------------------
// Mode: image-check
// ---------------------------------------------------------------------------

if (mode === 'image-check') {
  phase('Image check')
  const IMAGE_SCHEMA = {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'The image number as listed' },
            verdict: { type: 'string', enum: ['clean', 'sensitive', 'unsure'] },
            details: { type: 'string', description: 'What sensitive content is visible and where, or why it is unclear' }
          },
          required: ['number', 'verdict', 'details']
        }
      }
    },
    required: ['images']
  }
  // One agent looks at up to six images: the check is narrow and per-agent
  // overhead is most of the cost.
  const PER_AGENT = 6
  const images = A.images || []
  const batches = []
  for (let i = 0; i < images.length; i += PER_AGENT) batches.push(images.slice(i, i + PER_AGENT).map((img, j) => ({ ...img, number: i + j + 1 })))
  const answers = settled(await parallel(batches.map((batch, b) => () => agent(
    `You are checking screenshots before they are published in a pull request comment, possibly on a public repository.

Open each image with the Read tool and look at all of it:
${batch.map(img => `${img.number}. ${img.path}${img.what ? ` — ${img.what}` : ''}`).join('\n')}

For each, report whether any of this is visible: passwords, API keys, tokens, cookies or other credentials; real personal data (names, email addresses, phone numbers, postal addresses, payment or ID numbers) that is not obviously placeholder data; internal hostnames, IP addresses or file paths that name a person; private messages or documents.

One verdict per image, by its number:
- clean — nothing of the kind is visible.
- sensitive — say what and where.
- unsure — say what you could not judge (unreadable text, cropped content).
Do not edit or create files other than your answer.`,
    { label: `images:${b + 1}`, phase: 'Image check', agentType: 'general-purpose', schema: IMAGE_SCHEMA }))))
  // Only "clean" is publishable; a missing or failed check is not a clean one.
  const byNumber = {}
  answers.forEach(a => { for (const r of (a && a.images) || []) byNumber[r.number] = r })
  const results = images.map((img, i) => {
    const a = byNumber[i + 1]
    const verdict = a && ['clean', 'sensitive', 'unsure'].includes(a.verdict) ? a.verdict : 'unsure'
    return { path: img.path, verdict, details: a ? text(a.details) : 'The image check did not return a verdict for this image.', publish: verdict === 'clean' }
  })
  return { mode, images: results, withheld: results.filter(r => !r.publish).length }
}

// ---------------------------------------------------------------------------
// Mode: review
// ---------------------------------------------------------------------------

const tier = ['Core', 'Shared', 'Leaf', 'Inert'].includes(A.tier) ? A.tier : 'Shared'
const plan = planReviewers(tier, A.changedLines)

phase('Review')
log(`Tier ${tier}: ${plan.length} reviewer(s)${plan.length ? ` — ${plan.map(r => r.name).join(', ')}` : ''}`)

const reviewResults = settled(await parallel(plan.map(r => () => agent(reviewerPrompt(r),
  { label: r.name, phase: 'Review', agentType: 'general-purpose', schema: REVIEW_SCHEMA }))))

const discarded = []
const suppressed = []
let raised = []
const reviewers = plan.map((r, i) => {
  const res = reviewResults[i]
  if (res) {
    raised.push(...normalise(res.findings, r.name, discarded))
    for (const s of res.suppressed || []) {
      if (SUPPRESSION_RULES.includes(text(s.rule))) suppressed.push({ reviewer: r.name, rule: text(s.rule), file: text(s.file), claim: text(s.claim) })
    }
  }
  return { name: r.name, lenses: r.lenses, returned: Boolean(res), attacksTried: (res && res.attacksTried) || [] }
})

raised = assignIds(dedupe(raised), A.priorFindings)
const carried = raised.filter(alreadyDecided)
const fresh = raised.filter(f => !alreadyDecided(f))
log(`Raised ${raised.length} after de-duplication; ${carried.length} already decided on an earlier run`)

// --- Skeptic -----------------------------------------------------------------

phase('Skeptic')
const needsSkeptic = f => RANK[f.severity] >= RANK.important || (A.dontStop === true && f.severity === 'suggestion')
const toCheck = fresh.filter(needsSkeptic)
log(`Skeptic on ${toCheck.length} finding(s)`)

const verdicts = settled(await parallel(toCheck.map(f => () => agent(skepticPrompt(f),
  { label: `skeptic:${f.id}`, phase: 'Skeptic', agentType: 'general-purpose', schema: SKEPTIC_SCHEMA }))))

const rejected = []
const kept = []
for (const f of fresh) {
  const i = toCheck.indexOf(f)
  if (i === -1) { kept.push({ ...f, skeptic: 'skipped' }); continue }
  const v = verdicts[i]
  // A skeptic that failed has disproved nothing: keep the finding, marked unproven.
  if (!v) { kept.push({ ...f, skeptic: 'unproven', skepticReason: 'The skeptic did not return.' }); continue }
  const reason = text(v.reason)
  if (v.verdict === 'rejected') { rejected.push({ ...f, skeptic: 'rejected', skepticReason: reason }); continue }
  if (v.verdict === 'reduced' && v.newSeverity in RANK && RANK[v.newSeverity] < RANK[f.severity]) {
    kept.push({ ...f, severity: v.newSeverity, skeptic: 'reduced', skepticReason: reason })
    continue
  }
  kept.push({ ...f, skeptic: v.verdict === 'unproven' ? 'unproven' : 'confirmed', skepticReason: reason })
}

// --- Caps and result ---------------------------------------------------------

const CAP = 5
const findings = []
const collapsed = { suggestion: [], nit: [] }
const shown = { suggestion: 0, nit: 0 }
for (const f of kept.sort(bySeverity)) {
  if (f.severity in shown && ++shown[f.severity] > CAP) collapsed[f.severity].push(f)
  else findings.push(f)
}

const count = sev => kept.filter(f => f.severity === sev).length
const counts = {
  reviewers: reviewers.filter(r => r.returned).length,
  reviewersNotRun: reviewers.filter(r => !r.returned).map(r => r.name),
  raised: raised.length,
  confirmed: kept.filter(f => f.skeptic === 'confirmed' || f.skeptic === 'reduced').length,
  unproven: kept.filter(f => f.skeptic === 'unproven').length,
  rejected: rejected.length,
  suppressed: suppressed.length,
  carried: carried.length,
  discarded: discarded.length,
  blocking: count('blocking'), important: count('important'), suggestion: count('suggestion'), nit: count('nit')
}
log(`${counts.blocking} blocking · ${counts.important} important · ${counts.suggestion} suggestion · ${counts.nit} nit — ${counts.rejected} rejected by the skeptic`)

return { mode, tier, reviewers, findings, collapsed, rejected, carried, suppressed, discarded, counts }
