#!/usr/bin/env node
// Before/after screenshots: the base and the head are each started on their
// own port and the same pages are captured from both with headless Chrome at
// a fixed viewport.
//
//   node capture.js --repo <root> --base <sha> --out <dir> --start "<command>"
//                   --routes /orders,/customers [--viewport 1280x720]
//                   [--port-env PORT] [--ready-timeout 60]
//
// --start runs in each tree with the port in --port-env (default PORT).
// Writes <out>/before/<page>.png and <out>/after/<page>.png and prints
//   {"chrome", "pages": [{"route", "before", "after", "changed"}], "notRun"}
// "changed" compares the PNG bytes. Uses Chrome or Chromium if one is
// installed (CHROME_PATH overrides); without one it reports notRun and exits 0.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const http = require('http')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  s.on('error', reject)
})

const ping = url => new Promise(resolve => {
  const req = http.get(url, res => { res.resume(); resolve(res.statusCode) })
  req.on('error', () => resolve(0))
  req.setTimeout(2000, () => { req.destroy(); resolve(0) })
})

async function waitReady(url, seconds, proc) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    if (proc.exitCode !== null) return false
    const code = await ping(url)
    if (code && code < 500) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

function startApp(cmd, cwd, portEnv, port, logFile) {
  const out = fs.openSync(logFile, 'w')
  const env = { ...process.env, [portEnv]: String(port), BROWSER: 'none', NODE_ENV: 'development' }
  delete env.NODE_TEST_CONTEXT
  return spawn(cmd, { cwd, shell: true, detached: true, stdio: ['ignore', out, out], env })
}

function stopApp(proc) {
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
}

function shoot(chrome, url, file, [w, h]) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-chrome-'))
  try {
    const r = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', '--force-device-scale-factor=1', `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`, '--virtual-time-budget=5000', `--screenshot=${file}`, url
    ], { timeout: 90000, encoding: 'utf8' })
    if (!fs.existsSync(file)) throw new Error(`chrome produced no screenshot for ${url}: ${(r.stderr || '').split('\n').slice(-3).join(' ')}`)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

const slug = route => (route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'home')
const digest = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

async function main(argv) {
  const opt = { viewport: '1280x720', 'port-env': 'PORT', 'ready-timeout': 60 }
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]
  for (const k of ['repo', 'base', 'out', 'start', 'routes']) if (!opt[k]) throw new Error(`--${k} is required`)
  const repo = path.resolve(opt.repo), out = path.resolve(opt.out)
  const routes = String(opt.routes).split(',').map(r => r.trim()).filter(Boolean).map(r => (r.startsWith('/') ? r : `/${r}`))
  const viewport = String(opt.viewport).split('x').map(Number)
  const chrome = findChrome()
  if (!chrome) return { chrome: null, pages: [], notRun: 'no Chrome or Chromium installed' }

  fs.mkdirSync(path.join(out, 'before'), { recursive: true })
  fs.mkdirSync(path.join(out, 'after'), { recursive: true })
  const baseTree = path.join(out, 'base-tree')
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`)
  }
  git(['worktree', 'add', '--detach', '--force', baseTree, opt.base])
  for (const d of ['node_modules', '.venv', 'venv', 'vendor']) {
    if (fs.existsSync(path.join(repo, d)) && !fs.existsSync(path.join(baseTree, d))) fs.symlinkSync(path.join(repo, d), path.join(baseTree, d))
  }

  const apps = []
  try {
    const sides = []
    for (const [side, cwd] of [['before', baseTree], ['after', repo]]) {
      const port = await freePort()
      const proc = startApp(opt.start, cwd, opt['port-env'], port, path.join(out, `${side}-server.log`))
      apps.push(proc)
      const ready = await waitReady(`http://127.0.0.1:${port}${routes[0]}`, Number(opt['ready-timeout']), proc)
      if (!ready) {
        const log = fs.readFileSync(path.join(out, `${side}-server.log`), 'utf8').split('\n').slice(-5).join(' | ')
        return { chrome, pages: [], notRun: `the ${side === 'before' ? 'base' : 'head'} app did not start with "${opt.start}": ${log}` }
      }
      sides.push({ side, port })
    }
    const pages = []
    for (const route of routes) {
      const page = { route }
      for (const { side, port } of sides) {
        const file = path.join(out, side, `${slug(route)}.png`)
        shoot(chrome, `http://127.0.0.1:${port}${route}`, file, viewport)
        page[side] = file
      }
      page.changed = digest(page.before) !== digest(page.after)
      pages.push(page)
    }
    return { chrome, viewport: opt.viewport, pages, notRun: null }
  } finally {
    for (const p of apps) stopApp(p)
    try { git(['worktree', 'remove', '--force', baseTree]) } catch { /* already gone */ }
  }
}

module.exports = { main, findChrome, slug }

if (require.main === module) {
  main(process.argv.slice(2)).then(r => {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    process.exit(0)
  }, e => {
    process.stderr.write(`capture: ${e.message}\n`)
    process.exit(1)
  })
}
