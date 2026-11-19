#!/usr/bin/env node
// The repo's learned suppressions: findings the author declined and asked
// not to see again. Kept in .self-review/suppressions.yml, committed with the
// repo so it is reviewable and shared.
//
//   node suppressions.js list --repo <root>
//       prints [{"pattern", "reason"}] — pass as the review's `suppressions`
//   node suppressions.js add --repo <root> --pattern "<what to stop raising>" --reason "<why>" [--by <name>]
//
// A pattern describes a kind of finding in words ("console.log in scripts/ —
// these are CLI tools"), matched by the reviewers, not by code. Suppressions
// never apply to Blocking findings.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('./lib/yaml-lite.js')

const HEADER = `# Learned suppressions for /self-review.
# Each entry is a kind of finding the authors declined and asked not to see
# again. Reviewers skip findings that match and count them in the report.
# Suppressions never apply to Blocking findings. Edit or delete freely.
`

function load(repo) {
  const file = path.join(repo, '.self-review', 'suppressions.yml')
  if (!fs.existsSync(file)) return { file, items: [] }
  const doc = yaml.parse(fs.readFileSync(file, 'utf8')) || {}
  const items = Array.isArray(doc.suppressions) ? doc.suppressions : []
  return { file, items: items.filter(s => s && typeof s.pattern === 'string' && s.pattern.trim()) }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const opt = {}
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1]
  const repo = path.resolve(opt.repo || '.')
  const { file, items } = load(repo)
  if (cmd === 'list') return items.map(s => ({ pattern: s.pattern, reason: s.reason || '' }))
  if (cmd === 'add') {
    const pattern = String(opt.pattern || '').trim(), reason = String(opt.reason || '').trim()
    if (!pattern || !reason) throw new Error('add needs --pattern and --reason')
    if (items.some(s => s.pattern.toLowerCase() === pattern.toLowerCase())) return { added: false, why: 'already suppressed', file }
    const by = opt.by || spawnSync('git', ['-C', repo, 'config', 'user.name'], { encoding: 'utf8' }).stdout.trim() || 'unknown'
    const next = [...items, { pattern, reason, by, date: new Date().toISOString().slice(0, 10) }]
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml.stringifyList('suppressions', next, HEADER))
    return { added: true, file, count: next.length }
  }
  throw new Error('usage: suppressions.js list --repo <root> | add --repo <root> --pattern "…" --reason "…" [--by <name>]')
}

module.exports = { main }

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`suppressions: ${e.message}\n`)
    process.exit(1)
  }
}
