#!/usr/bin/env node
// Runs the scanners a repo already has and turns their output into leads for
// the reviewers. Installs nothing.
//
//   node scan.js --repo <root> --work <workDir> [--timeout <seconds>]
//
// - secrets: always — the diff's added lines through redact.js's patterns
// - npm audit: when package.json or a lockfile changed and npm is available
// - the repo's own scanners: .self-review/config.yml →
//       scanners:
//         - name: semgrep
//           cmd: semgrep --config auto --json
//
// Writes <work>/leads/<name>.<ext> and prints {"leads": [...], "ran": [...], "skipped": [...]};
// "leads" are paths relative to <work>, ready for the review's `leads` arg.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scan } = require('./redact.js')
const yaml = require('./lib/yaml-lite.js')

function main(argv) {
  const opt = { timeout: 300 }
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!opt.repo || !opt.work) throw new Error('--repo and --work are required')
  const repo = path.resolve(opt.repo), work = path.resolve(opt.work)
  const leadsDir = path.join(work, 'leads')
  fs.mkdirSync(leadsDir, { recursive: true })
  const res = { leads: [], ran: [], skipped: [] }
  const lead = (name, content) => { fs.writeFileSync(path.join(leadsDir, name), content); res.leads.push(`leads/${name}`) }
  const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  const sh = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, timeout: Number(opt.timeout) * 1000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  // Secrets in what the PR adds.
  const hits = scan(read(path.join(work, 'full.diff')), { addedOnly: true })
  res.ran.push({ name: 'secrets', findings: hits.length })
  if (hits.length) lead('secrets.json', JSON.stringify({ about: 'Lines this PR adds that look like secrets or personal data (values masked). Line numbers are within full.diff.', hits }, null, 2))

  // Dependency audit, only when dependencies changed.
  const changed = read(path.join(work, 'files-prod.txt')).split('\n').filter(Boolean)
  const depsChanged = changed.some(f => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(f))
  if (!depsChanged) res.skipped.push({ name: 'npm-audit', why: 'dependencies unchanged' })
  else if (!fs.existsSync(path.join(repo, 'package-lock.json'))) res.skipped.push({ name: 'npm-audit', why: 'no package-lock.json' })
  else if (spawnSync('npm', ['--version']).status !== 0) res.skipped.push({ name: 'npm-audit', why: 'npm not available' })
  else {
    const r = sh('npm audit --json', repo)
    let summary = null
    try { summary = JSON.parse(r.stdout).metadata.vulnerabilities } catch { /* not JSON: keep raw output */ }
    res.ran.push({ name: 'npm-audit', exit: r.status, vulnerabilities: summary })
    lead('npm-audit.json', r.stdout || r.stderr || '')
  }

  // The repo's configured scanners.
  let config = null
  const configFile = path.join(repo, '.self-review', 'config.yml')
  if (fs.existsSync(configFile)) {
    try { config = yaml.parse(fs.readFileSync(configFile, 'utf8')) } catch (e) { res.skipped.push({ name: 'config', why: `.self-review/config.yml: ${e.message}` }) }
  }
  for (const s of (config && Array.isArray(config.scanners) ? config.scanners : [])) {
    const name = String((s && s.name) || '').replace(/[^A-Za-z0-9_-]+/g, '-')
    if (!name || !s.cmd) { res.skipped.push({ name: name || '(unnamed)', why: 'needs name and cmd' }); continue }
    const r = sh(String(s.cmd), repo)
    const timedOut = r.error && r.error.code === 'ETIMEDOUT'
    res.ran.push({ name, exit: timedOut ? 'timeout' : r.status })
    lead(`${name}.txt`, `$ ${s.cmd}\n(exit ${timedOut ? 'timeout' : r.status})\n\n${r.stdout || ''}${r.stderr || ''}`)
  }
  return res
}

module.exports = { main }

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`scan: ${e.message}\n`)
    process.exit(1)
  }
}
