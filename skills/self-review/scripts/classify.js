#!/usr/bin/env node
// A first guess at each changed file's review tier and change kind, from the
// repo's config, path patterns and fan-in (how many files import it). The
// brief agent starts from this and says where it differs; tiers that come
// from .self-review/config.yml are binding. Rules: depth-and-proof.md.
//
//   node classify.js --repo <root> --work <workDir>
//
// Reads <work>/files-prod.txt and files-test.txt; writes <work>/classify.json:
//   {"tier", "fanInShared", "areas": [{"file", "tier", "kind", "fanIn", "reasons"}]}
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const yaml = require('./lib/yaml-lite.js')

const TIERS = ['Inert', 'Leaf', 'Shared', 'Core']
const higher = (a, b) => (TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b)

const PATTERNS = {
  Inert: [/\.(md|mdx|rst|txt|adoc)$/i, /(^|\/)docs?\//i, /(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS)(\.\w+)?$/i, /(^|\/)\.(editorconfig|prettierrc[^/]*|gitignore|gitattributes)$/i],
  Core: [
    /(^|\/)(auth|authn|authz|oauth|sso|session|sessions|security|permissions?|rbac|acl)(\/|\.|_|-)/i,
    /(^|\/)(migrations?|migrate|schema|db|database|models?)\//i, /\.(sql|prisma)$/i,
    /(^|\/)(payments?|billing|checkout|stripe|invoices?)(\/|\.|_|-)/i,
    /(^|\/)(infra|infrastructure|terraform|deploy|deployment|k8s|kubernetes|helm|ansible)\//i, /\.tf$/i,
    /(^|\/)\.github\/workflows\//, /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/,
    /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/, /(^|\/)(webpack|vite|rollup|babel|tsconfig|next|nuxt)\.config\.[cm]?[jt]s$|(^|\/)tsconfig[^/]*\.json$/,
    /(^|\/)(api|public-api)\/v\d+\//i
  ],
  Shared: [/(^|\/)(lib|libs|utils?|helpers?|shared|common|core|hooks|packages)\//i, /(^|\/)components\/(ui|common|shared)\//i,
    /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/],
  Leaf: [/\.(css|scss|sass|less|styl)$/i, /(^|\/)(pages|views|screens|routes|app)\//i, /(^|\/)(i18n|locales?|translations?)\//i, /\.(svg|png|jpe?g|gif|webp)$/i]
}

const KIND = [
  { kind: 'inert', re: PATTERNS.Inert },
  { kind: 'visual', re: [/\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp)$/i, /(^|\/)(components|pages|views|screens|layouts?)\/.*\.(tsx|jsx|vue|svelte|html|erb|hbs)$/i, /\.(vue|svelte)$/i] },
  { kind: 'api-cli', re: [/(^|\/)(routes|api|controllers?|handlers?|endpoints|cli|bin|commands)\//i] }
]

const CODE = /\.(m?[jt]sx?|cjs|py)$/
// Same test-file rule as gather.sh. Tests importing a module is not use.
const TEST = /(^|\/)(tests?|specs?|__tests__|__mocks__|__snapshots__|fixtures|testdata|e2e|cypress)\/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/
const JS_EXT = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.tsx', '/index.jsx']

function glob(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Who imports `target`? JS/TS relative imports and Python module paths.
function importers(target, files, readFile) {
  const out = []
  const noExt = target.replace(/\.(m?[jt]sx?|cjs)$/, '')
  const pyModule = target.endsWith('.py') ? target.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.') : null
  for (const f of files) {
    if (f === target) continue
    const src = readFile(f)
    if (!src) continue
    if (/\.(m?[jt]sx?|cjs)$/.test(f) && /\.(m?[jt]sx?|cjs)$/.test(target)) {
      const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g
      let m
      while ((m = re.exec(src))) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))
        if (JS_EXT.some(e => resolved + e === target || resolved === noExt + e.replace(/^\.\w+$/, ''))) { out.push(f); break }
      }
    } else if (pyModule && f.endsWith('.py')) {
      const esc = pyModule.replace(/\./g, '\\.')
      if (new RegExp(`^\\s*(from\\s+${esc}\\s+import|import\\s+${esc}\\b)`, 'm').test(src)) out.push(f)
    }
  }
  return out
}

function testedFile(testFile, prodFiles) {
  const base = path.posix.basename(testFile)
    .replace(/\.(test|spec)(?=\.[^.]+$)/, '').replace(/_test(?=\.[^.]+$)/, '').replace(/^test_/, '')
  return prodFiles.find(p => path.posix.basename(p) === base) || null
}

function main(argv) {
  const opt = {}
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!opt.repo || !opt.work) throw new Error('--repo and --work are required')
  const repo = path.resolve(opt.repo), work = path.resolve(opt.work)
  const list = f => (fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f), 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [])
  const prod = list('files-prod.txt'), tests = list('files-test.txt')

  let config = {}
  const configFile = path.join(repo, '.self-review', 'config.yml')
  if (fs.existsSync(configFile)) config = yaml.parse(fs.readFileSync(configFile, 'utf8')) || {}
  const fanInShared = Number(config.fanInShared) > 0 ? Number(config.fanInShared) : 2
  const configTiers = []
  for (const t of TIERS) for (const g of [].concat((config.tiers || {})[t] || [])) configTiers.push({ tier: t, re: glob(String(g)), glob: g })

  const tracked = spawnSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n')
    .filter(f => CODE.test(f) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(f)).slice(0, 8000)
  const cache = new Map()
  const readFile = f => {
    if (!cache.has(f)) {
      let s = ''
      try { const p = path.join(repo, f); if (fs.statSync(p).size < 512 * 1024) s = fs.readFileSync(p, 'utf8') } catch { /* deleted or unreadable */ }
      cache.set(f, s)
    }
    return cache.get(f)
  }

  const classify = file => {
    const reasons = []
    const kind = (KIND.find(k => k.re.some(r => r.test(file))) || { kind: 'behaviour' }).kind
    const fromConfig = configTiers.find(c => c.re.test(file))
    if (fromConfig) return { file, tier: fromConfig.tier, kind, fanIn: null, reasons: [`config: ${fromConfig.glob}`], binding: true }
    if (PATTERNS.Inert.some(r => r.test(file))) return { file, tier: 'Inert', kind: 'inert', fanIn: null, reasons: ['docs or non-shipping file'] }
    let tier = 'Leaf'
    const core = PATTERNS.Core.find(r => r.test(file))
    if (core) { tier = 'Core'; reasons.push('path matches a Core area (auth, data, payments, infra, CI, build config, versioned API)') }
    let fanIn = null
    if (CODE.test(file)) {
      const who = importers(file, tracked.filter(f => !TEST.test(f)), readFile)
      fanIn = who.length
      if (fanIn >= fanInShared) { tier = higher(tier, 'Shared'); reasons.push(`imported by ${fanIn} files (${who.slice(0, 4).join(', ')}${who.length > 4 ? ', …' : ''})`) }
    }
    if (PATTERNS.Shared.some(r => r.test(file))) { tier = higher(tier, 'Shared'); reasons.push('path is a shared library, utility or dependency manifest') }
    if (!reasons.length) reasons.push(fanIn === null ? 'no Core or Shared signal; fan-in not measured for this file type' : `no Core or Shared signal; imported by ${fanIn} file(s)`)
    return { file, tier, kind, fanIn, reasons }
  }

  const areas = prod.map(classify)
  for (const t of tests) {
    const source = testedFile(t, prod) || testedFile(t, tracked)
    const of = source ? (areas.find(a => a.file === source) || classify(source)) : null
    areas.push(of
      ? { file: t, tier: of.tier, kind: of.kind, fanIn: null, reasons: [`test for ${source}`] }
      : { file: t, tier: 'Leaf', kind: 'behaviour', fanIn: null, reasons: ['test; the code it tests was not identified'] })
  }
  const result = { tier: areas.reduce((t, a) => higher(t, a.tier), 'Inert'), fanInShared, areas }
  fs.writeFileSync(path.join(work, 'classify.json'), JSON.stringify(result, null, 2))
  return result
}

module.exports = { main, glob, importers }

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`)
  } catch (e) {
    process.stderr.write(`classify: ${e.message}\n`)
    process.exit(1)
  }
}
