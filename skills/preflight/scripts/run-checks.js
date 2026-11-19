#!/usr/bin/env node
// Runs the project's checks on the head, re-runs failures to spot flaky
// tests, compares what still fails with the base (regression or
// pre-existing), and produces behaviour proof: the PR's changed tests run
// against the base code should fail there and pass on the head.
//
//   node run-checks.js --repo <root> --out <dir> --cmd "<command>" [--cmd …]
//                      [--base <sha>] [--reruns 2] [--timeout <seconds>]
//                      [--proof-tests <file listing test paths>] [--proof-cmd "<command>"]
//                      [--test-diff <test.diff>]
//
// Prints JSON (also saved to <out>/checks.json) with one entry per command and
// report-ready rows: tests, regression, proof. Logs go to <out>/logs/. With
// --test-diff, proof.passOnBase lists tests the PR added or changed that pass
// on the base as well (named in an added line): a lead that they may not test
// the change.
// Failing tests are read from common reporters (node:test TAP and spec, Jest
// and Vitest, pytest, go test, cargo, rspec); when none matches, comparison
// falls back to whole commands and the notes say so.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const PATTERNS = [
  /^\s*not ok \d+ - (.+?)\s*$/,                          // TAP (node --test piped)
  /^\s*✖ (.+?)(?: \([\d.]+\s*m?s\))?\s*$/,               // node --test spec reporter
  /^\s*[✕×] (.+?)(?: \(\d+(?:\.\d+)?\s*m?s\))?\s*$/,     // Jest, Vitest
  /^(?:FAILED|ERROR) (\S+)/,                             // pytest -rfE / summary
  /^\s*--- FAIL: (\S+)/,                                 // go test
  /^test (\S+) \.\.\. FAILED$/,                          // cargo test
  /^rspec (\.\/\S+)/                                     // rspec
]

const PASS_PATTERNS = [
  /^\s*ok \d+ - (.+?)\s*$/,                              // TAP
  /^\s*✔ (.+?)(?: \([\d.]+\s*m?s\))?\s*$/,               // node --test spec reporter
  /^\s*✓ (.+?)(?: \(\d+(?:\.\d+)?\s*m?s\))?\s*$/,        // Jest, Vitest
  /^(\S+::\S+) PASSED/,                                  // pytest -v
  /^\s*--- PASS: (\S+)/,                                 // go test -v
  /^test (\S+) \.\.\. ok$/                               // cargo test
]

function parsePasses(output) {
  const found = new Set()
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    if (/#\s*(TODO|SKIP)\b/i.test(line)) continue
    for (const re of PASS_PATTERNS) { const m = re.exec(line); if (m) { found.add(m[1].trim()); break } }
  }
  return [...found]
}

// Does the text name this test? Either as an exact quoted title ('add', so
// "add" is not found inside 'add more'), or as a function definition
// (def test_y, func TestThing, fn it_works) for pytest, go and cargo names.
function namedIn(text, name) {
  if (['"', "'", '`'].some(q => text.includes(`${q}${name}${q}`))) return true
  const last = name.split('::').pop()
  return /^[A-Za-z_]\w*$/.test(last) && new RegExp(`\\b(def|func|fn|function)\\s+${last}\\b`).test(text)
}

function parseFailures(output, roots) {
  const found = new Set()
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    if (/#\s*(TODO|SKIP)\b/i.test(line)) continue
    for (const re of PATTERNS) {
      const m = re.exec(line)
      if (m) {
        let name = m[1].trim()
        for (const r of roots) if (r) name = name.split(`${r}/`).join('').split(r).join('')
        found.add(name)
        break
      }
    }
  }
  return found.size ? [...found].sort() : null
}

function run(cmd, cwd, timeout, logFile) {
  const t0 = Date.now()
  // The project's checks must not inherit a parent test runner's context
  // (node --test inside node --test reports to the parent and exits 0).
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(cmd, { cwd, shell: true, timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024, env })
  const output = `${r.stdout || ''}${r.stderr || ''}`
  fs.writeFileSync(logFile, `$ ${cmd}\n(cwd ${cwd})\n\n${output}`)
  const timedOut = r.error && r.error.code === 'ETIMEDOUT'
  return { exit: timedOut ? 'timeout' : r.status, output, seconds: Math.round((Date.now() - t0) / 1000), log: logFile }
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

// A checkout of the base next to the head, sharing installed dependencies.
function worktree(repo, sha, dir) {
  git(repo, ['worktree', 'add', '--detach', '--force', dir, sha])
  for (const d of ['node_modules', '.venv', 'venv', 'vendor']) {
    const src = path.join(repo, d)
    if (fs.existsSync(src) && !fs.existsSync(path.join(dir, d))) fs.symlinkSync(src, path.join(dir, d))
  }
  return dir
}

function main(argv) {
  const opt = { cmd: [], reruns: 2, timeout: 900 }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '')
    const v = argv[++i]
    if (k === 'cmd') opt.cmd.push(v)
    else if (['repo', 'out', 'base', 'reruns', 'timeout', 'proof-tests', 'proof-cmd', 'test-diff'].includes(k)) opt[k] = v
    else throw new Error(`unknown option --${k}`)
  }
  if (!opt.repo || !opt.out || !opt.cmd.length) throw new Error('--repo, --out and at least one --cmd are required')
  const repo = path.resolve(opt.repo)
  const out = path.resolve(opt.out)
  const logs = path.join(out, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  const reruns = Number(opt.reruns), timeout = Number(opt.timeout)
  const trees = []
  let baseTree = null
  const roots = () => [repo, ...trees]

  try {
    const commands = opt.cmd.map((cmd, n) => {
      const tag = `${n + 1}`
      const runs = [run(cmd, repo, timeout, path.join(logs, `${tag}-head-1.log`))]
      const entry = { cmd, head: null, flaky: [], base: null, regressions: [], preExisting: [], result: 'Pass', notes: [] }
      // Re-run failures: a test that fails and then passes is flaky, not the PR's.
      for (let i = 2; runs[runs.length - 1].exit !== 0 && i <= reruns + 1; i++) {
        runs.push(run(cmd, repo, timeout, path.join(logs, `${tag}-head-${i}.log`)))
      }
      const failSets = runs.map(r => (r.exit === 0 ? [] : parseFailures(r.output, roots())))
      const last = runs[runs.length - 1]
      const parsed = failSets.every(s => s !== null)
      const everFailed = parsed ? [...new Set(failSets.flat())] : []
      const persistent = last.exit === 0 ? [] : (parsed ? failSets[failSets.length - 1] : null)
      entry.flaky = parsed ? everFailed.filter(t => !(persistent || []).includes(t)) : []
      entry.head = { exit: last.exit, runs: runs.length, failing: persistent, logs: runs.map(r => r.log), seconds: runs.reduce((a, r) => a + r.seconds, 0) }
      if (last.exit === 0) {
        entry.result = runs.length > 1 ? 'Flaky' : 'Pass'
        if (runs.length > 1 && !entry.flaky.length) entry.notes.push(`failed, then passed on re-run ${runs.length}`)
        return entry
      }
      if (last.exit === 'timeout') entry.notes.push(`timed out after ${timeout}s`)
      if (!opt.base) { entry.result = 'Fail'; entry.notes.push('no base given: cannot tell regressions from pre-existing failures'); return entry }

      if (!baseTree) { baseTree = worktree(repo, opt.base, path.join(out, 'base')); trees.push(baseTree) }
      const b = run(cmd, baseTree, timeout, path.join(logs, `${tag}-base.log`))
      const baseFailing = b.exit === 0 ? [] : parseFailures(b.output, roots())
      entry.base = { exit: b.exit, failing: baseFailing, log: b.log }
      if (persistent && baseFailing) {
        entry.regressions = persistent.filter(t => !baseFailing.includes(t))
        entry.preExisting = persistent.filter(t => baseFailing.includes(t))
        entry.result = entry.regressions.length ? 'Fail' : 'Pre-existing'
      } else {
        entry.notes.push('failing tests could not be read from the output; compared whole commands')
        entry.result = b.exit === 0 ? 'Fail' : 'Pre-existing'
        if (b.exit === 0) entry.regressions = ['(command passes on base, fails on head)']
      }
      return entry
    })

    // Behaviour proof: the head's changed tests, run against the base code.
    let proof = { result: 'Not run', notes: 'no changed tests to run against the base', items: [] }
    const listed = opt['proof-tests'] && fs.existsSync(opt['proof-tests'])
      ? fs.readFileSync(opt['proof-tests'], 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : []
    const testFiles = listed.filter(f => fs.existsSync(path.join(repo, f)))
    if (testFiles.length && !opt.base) proof.notes = 'no base given'
    else if (testFiles.length) {
      const proofTree = worktree(repo, opt.base, path.join(out, 'proof'))
      trees.push(proofTree)
      for (const f of testFiles) {
        fs.mkdirSync(path.dirname(path.join(proofTree, f)), { recursive: true })
        fs.copyFileSync(path.join(repo, f), path.join(proofTree, f))
      }
      const cmd = opt['proof-cmd'] || opt.cmd[0]
      const p = run(cmd, proofTree, timeout, path.join(logs, 'proof-base.log'))
      const headEntry = commands.find(c => c.cmd === cmd)
      const headFailing = headEntry ? (headEntry.head.failing || []) : []
      const headPassed = headEntry ? headEntry.head.exit === 0 : true
      if (p.exit === 0) {
        proof = { result: 'Not produced', items: [], notes: "the PR's changed tests also pass on the base, so they do not show the change", log: p.log }
      } else {
        const baseFailing = parseFailures(p.output, roots())
        if (baseFailing) {
          const items = baseFailing.filter(t => !headFailing.includes(t)).map(t => ({ test: t, base: 'fails', head: 'passes' }))
          proof = items.length
            ? { result: 'Provided', items, notes: `${items.length} test(s) fail on the base and pass on the head`, log: p.log }
            : { result: 'Not produced', items: [], notes: 'the tests that fail on the base also fail on the head', log: p.log }
        } else if (headPassed) {
          proof = { result: 'Provided', items: [{ test: `${cmd} (whole command)`, base: 'fails', head: 'passes' }], notes: 'failing tests could not be read; the command fails on the base and passes on the head', log: p.log }
        } else {
          proof = { result: 'Not produced', items: [], notes: 'the command fails on both base and head', log: p.log }
        }
      }
      proof.testFiles = testFiles
      // Tests the PR added or changed that pass on the base too do not show the
      // change: a lead for the test reviewer, not a verdict.
      const added = opt['test-diff'] && fs.existsSync(opt['test-diff'])
        ? fs.readFileSync(opt['test-diff'], 'utf8').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n') : ''
      proof.passOnBase = added ? parsePasses(p.output).filter(name => namedIn(added, name)) : []
    }

    // Report rows.
    const failed = commands.filter(c => c.result === 'Fail')
    const pre = commands.filter(c => c.result === 'Pre-existing')
    const flaky = commands.filter(c => c.result === 'Flaky')
    const notes = []
    if (failed.length) notes.push(`failing: ${failed.map(c => `\`${c.cmd}\``).join(', ')}`)
    if (pre.length) notes.push(`pre-existing failures (also fail on base): ${pre.map(c => `\`${c.cmd}\``).join(', ')}`)
    if (flaky.length) notes.push(`flaky: ${flaky.map(c => (c.flaky.length ? c.flaky.join(', ') : `\`${c.cmd}\``)).join('; ')}`)
    const tests = { result: failed.length ? 'Fail' : 'Pass', label: `local ${opt.cmd.map(c => `\`${c}\``).join(', ')}`, notes: notes.join('; ') }
    const unknownBase = failed.some(c => !c.base)
    const regression = failed.length
      ? (unknownBase ? { result: 'Not run', notes: 'no base to compare with' }
        : { result: 'Fail', notes: `regressions: ${failed.flatMap(c => c.regressions).join(', ')}` })
      : { result: 'Pass', notes: pre.length ? 'failures on head also fail on base' : 'everything passes on head' }
    const proofRow = { result: proof.result, notes: proof.notes }
    const markdown = proof.items.length
      ? ['| Test | Base | Head |', '|---|---|---|', ...proof.items.map(i => `| \`${i.test.replace(/\|/g, '\\|')}\` | ❌ fails | ✅ passes |`)].join('\n')
      : null

    const result = { commands, proof, rows: { tests, regression, proof: proofRow }, proofMarkdown: markdown }
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(result, null, 2))
    return result
  } finally {
    for (const t of trees) { try { git(repo, ['worktree', 'remove', '--force', t]) } catch { /* already gone */ } }
  }
}

module.exports = { main, parseFailures, parsePasses, namedIn }

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`run-checks: ${e.message}\n`)
    process.exit(1)
  }
}
