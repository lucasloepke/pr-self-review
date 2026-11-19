#!/usr/bin/env node
// Runs review-workflow.js when no Workflow tool is available. Each agent the
// workflow asks for becomes a prompt file; the session starts one fresh
// subagent per file, which writes its answer as JSON; running this again
// replays every answer through the workflow, which may ask for more agents
// (skeptics after reviewers). Repeat until the status is "done".
//
//   node run-workflow.js <args.json> <run-dir> [--final]
//
// Prints one JSON object:
//   {"status":"pending","pending":[{"label","prompt","answer"}],"invalid":[...]}
//   {"status":"done","result":"<run-dir>/result.json","invalid":[...]}
// --final   treat agents with no answer as failed instead of pending (use when
//           a subagent finished without writing its answer)
// A malformed answer counts as a failed agent and is listed under "invalid".
// A run-dir is tied to its args: reuse with different args is refused.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function fail(msg) { process.stderr.write(`run-workflow: ${msg}\n`); process.exit(1) }

const argv = process.argv.slice(2)
const final = argv.includes('--final')
const [argsFile, runDir] = argv.filter(a => a !== '--final')
if (!argsFile || !runDir) fail('usage: run-workflow.js <args.json> <run-dir> [--final]')

const skillDir = path.resolve(__dirname, '..')
let args
try { args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) } catch (e) { fail(`cannot read ${argsFile}: ${e.message}`) }
args.skillDir = args.skillDir || skillDir
for (const k of ['mode', 'repoRoot', 'workDir']) if (!args[k]) fail(`args.${k} is required`)

const answers = path.join(runDir, 'answers')
const prompts = path.join(runDir, 'prompts')
fs.mkdirSync(answers, { recursive: true })
fs.mkdirSync(prompts, { recursive: true })

const argsHash = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex')
const stamp = path.join(runDir, 'args.sha256')
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() !== argsHash) {
  fail(`${runDir} was used with different args; use a new run-dir`)
}
fs.writeFileSync(stamp, argsHash)

const src = fs.readFileSync(path.join(skillDir, 'review-workflow.js'), 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflow = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', src)

const slug = label => label.replace(/[^a-zA-Z0-9-]+/g, '_')
const pending = []
const invalid = []

async function agent(prompt, opts) {
  const answer = path.join(answers, `${slug(opts.label)}.json`)
  if (fs.existsSync(answer)) {
    try {
      const value = JSON.parse(fs.readFileSync(answer, 'utf8'))
      if (value && typeof value === 'object') return value
      throw new Error('not a JSON object')
    } catch (e) {
      invalid.push({ label: opts.label, answer, error: e.message })
      return null
    }
  }
  if (final) return null
  const file = path.join(prompts, `${slug(opts.label)}.md`)
  fs.writeFileSync(file, `${prompt}

---
OUTPUT. When you are done, write your answer as one JSON object matching the JSON Schema below to:
${answer}
That file is outside the repository and is the only file you may write. Then reply with the single word: done.

${JSON.stringify(opts.schema, null, 2)}
`)
  pending.push({ label: opts.label, prompt: file, answer })
  return null
}

const parallel = fns => Promise.all(fns.map(fn => fn()))
const log = m => process.stderr.write(`${m}\n`)

workflow(args, agent, parallel, () => {}, log).then(result => {
  if (pending.length) {
    process.stdout.write(`${JSON.stringify({ status: 'pending', pending, invalid }, null, 2)}\n`)
    return
  }
  const out = path.join(runDir, 'result.json')
  fs.writeFileSync(out, JSON.stringify(result, null, 2))
  process.stdout.write(`${JSON.stringify({ status: 'done', result: out, invalid }, null, 2)}\n`)
}, e => fail(e.stack || e.message))
