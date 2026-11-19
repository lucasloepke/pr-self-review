#!/usr/bin/env node
// Masks secrets and personal data in text bound for GitHub.
//
//   node redact.js mask <in> [<out>]   mask in place (or into <out>); prints {"total", "kinds"}
//   node redact.js scan <in>           list hits with line numbers, masked; changes nothing
//   node redact.js scan-diff <diff>    as scan, but only added lines (+) of a unified diff
//
// Every hit becomes [REDACTED:<kind>]; home paths become ~. Replacements hold
// no quotes or backslashes, so JSON (the report's state block) stays valid.
'use strict'
const fs = require('fs')

const R = kind => `[REDACTED:${kind}]`
const SAFE_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com)$|^(no-?reply|noreply\+[^@]*)@/i

// Order matters: specific token shapes before the generic patterns.
const RULES = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'api-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'`]+:[^\s/@"'`]+@/gi, to: (m, scheme) => `${scheme}${R('url-credentials')}@` },
  { kind: 'auth-header', re: /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"'`,;]+/gi, to: (m, p) => `${p}${R('auth-header')}` },
  { kind: 'cookie', re: /\b((?:set-)?cookie\s*:\s*)[^\n"'`]+/gi, to: (m, p) => `${p}${R('cookie')}` },
  {
    // KEY=value / key: "value" where the key names a secret and the value looks like one
    kind: 'secret-assignment',
    re: /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([A-Za-z0-9_\-+/=.:]{8,})\3/gi,
    to: (m, key, sep, q, value) => (q || (/\d/.test(value) && /[A-Za-z]/.test(value)) ? `${key}${sep}${q}${R('secret')}${q}` : m)
  },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: m => (SAFE_EMAIL.test(m) ? m : R('email')) },
  { kind: 'home-path', re: /\/(?:Users|home)\/[^/\s"'`:]+/g, to: () => '~' },
  { kind: 'home-path', re: /\b[A-Za-z]:\\(?:\\)?Users\\(?:\\)?[^\\\s"'`]+/g, to: () => '~' }
]

function redact(text) {
  const kinds = {}
  let out = String(text)
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      const m = args[0]
      const replaced = rule.to ? rule.to(...args) : R(rule.kind)
      if (replaced !== m) kinds[rule.kind] = (kinds[rule.kind] || 0) + 1
      return replaced
    })
  }
  return { text: out, kinds, total: Object.values(kinds).reduce((a, b) => a + b, 0) }
}

function scan(text, { addedOnly = false } = {}) {
  const hits = []
  String(text).split('\n').forEach((line, i) => {
    if (addedOnly && !(line.startsWith('+') && !line.startsWith('+++'))) return
    const r = redact(line)
    if (r.total) hits.push({ line: i + 1, kinds: Object.keys(r.kinds), masked: r.text.slice(0, 200) })
  })
  return hits
}

module.exports = { redact, scan }

if (require.main === module) {
  const [cmd, input, output] = process.argv.slice(2)
  const fail = m => { process.stderr.write(`redact: ${m}\n`); process.exit(1) }
  if (!cmd || !input) fail('usage: redact.js mask <in> [<out>] | scan <in> | scan-diff <diff>')
  let text
  try { text = fs.readFileSync(input, 'utf8') } catch (e) { fail(e.message) }
  if (cmd === 'mask') {
    const r = redact(text)
    fs.writeFileSync(output || input, r.text)
    process.stdout.write(`${JSON.stringify({ total: r.total, kinds: r.kinds })}\n`)
  } else if (cmd === 'scan' || cmd === 'scan-diff') {
    process.stdout.write(`${JSON.stringify(scan(text, { addedOnly: cmd === 'scan-diff' }), null, 2)}\n`)
  } else fail(`unknown command ${cmd}`)
}
