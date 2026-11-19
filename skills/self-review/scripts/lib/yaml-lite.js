// A small YAML subset, enough for .self-review/config.yml and
// suppressions.yml without a dependency: nested maps, lists of scalars, lists
// of maps, quoted and plain scalars, flow lists like [a, "b"], and comments.
// Anchors, multi-line strings and flow maps are not supported and throw.
'use strict'

function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if ((c === '"' || c === "'") && /(^|[:\-[,])$/.test(line.slice(0, i).trimEnd())) {
      quote = c   // a quote opens only where a value starts, so "it's" stays plain
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function scalar(raw, lineNo) {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"')) {
    try { return JSON.parse(s) } catch { throw new Error(`line ${lineNo}: bad double-quoted string`) }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`line ${lineNo}: bad single-quoted string`)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`line ${lineNo}: unterminated flow list`)
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    const items = []
    let cur = '', quote = null
    for (const c of inner) {
      if (quote) { cur += c; if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") { quote = c; cur += c; continue }
      if (c === ',') { items.push(cur); cur = ''; continue }
      cur += c
    }
    items.push(cur)
    return items.map(i => scalar(i, lineNo))
  }
  if (s.startsWith('{') || s.startsWith('&') || s.startsWith('*') || s === '|' || s === '>') {
    throw new Error(`line ${lineNo}: unsupported YAML (${s.slice(0, 10)})`)
  }
  return s
}

function parse(text) {
  const lines = []
  String(text).replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    if (raw.includes('\t') && /^\s*\t/.test(raw)) throw new Error(`line ${i + 1}: tabs are not allowed for indentation`)
    const content = stripComment(raw).replace(/\s+$/, '')
    if (content.trim() === '' || content.trim() === '---') return
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), no: i + 1 })
  })
  if (!lines.length) return null
  const [value, next] = block(lines, 0, lines[0].indent)
  if (next < lines.length) throw new Error(`line ${lines[next].no}: unexpected indentation`)
  return value
}

function block(lines, i, indent) {
  return lines[i].text.startsWith('- ') || lines[i].text === '-' ? list(lines, i, indent) : map(lines, i, indent)
}

function list(lines, i, indent) {
  const out = []
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2)
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, n] = block(lines, i + 1, lines[i + 1].indent); out.push(v); i = n
      } else { out.push(null); i++ }
    } else if (/^[^"'[][^:]*:(\s|$)/.test(rest)) {
      // "- key: value" starts a map whose keys sit two columns in.
      lines[i] = { ...lines[i], indent: indent + 2, text: rest }
      const [v, n] = map(lines, i, indent + 2); out.push(v); i = n
    } else {
      out.push(scalar(rest, lines[i].no)); i++
    }
  }
  return [out, i]
}

function map(lines, i, indent) {
  const out = {}
  while (i < lines.length && lines[i].indent === indent) {
    const { text, no } = lines[i]
    const m = /^("[^"]*"|'[^']*'|[^:]+?):(\s+(.*))?$/.exec(text)
    if (!m || text.startsWith('- ')) throw new Error(`line ${no}: expected "key: value"`)
    const key = String(scalar(m[1], no))
    const rest = m[3] === undefined ? '' : m[3]
    i++
    if (rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [v, n] = block(lines, i, lines[i].indent); out[key] = v; i = n
      } else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
        const [v, n] = list(lines, i, indent); out[key] = v; i = n   // list at the key's own indent
      } else out[key] = null
    } else out[key] = scalar(rest, no)
  }
  if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].no}: unexpected indentation`)
  return [out, i]
}

// Writes a list of flat maps under one key, strings double-quoted.
function stringifyList(key, items, header = '') {
  const q = v => (typeof v === 'string' ? JSON.stringify(v) : v === null || v === undefined ? 'null' : String(v))
  const body = items.map(item => Object.entries(item)
    .map(([k, v], j) => `${j === 0 ? '  - ' : '    '}${k}: ${q(v)}`).join('\n')).join('\n')
  return `${header}${key}:${items.length ? `\n${body}` : ' []'}\n`
}

module.exports = { parse, stringifyList }
