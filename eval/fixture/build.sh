#!/usr/bin/env bash
# Builds the evaluation fixture: a small Node API repo whose branches are the
# test cases. The answer key for each branch is in ../expected.json; its PR
# description and ticket are in descriptions/<branch-name>.md and .issue.md.
#
#   bash build.sh <dir>        # <dir> is deleted and rebuilt
#
# Branches:
#   feature/order-filters       four planted defects, plus one unexplained change (see expected.json)
#   feature/order-count         clean
#   feature/order-status-badge  UI change with a visual regression and an unescaped value
#
# main also serves two admin pages (npm start → /orders, /customers) so UI
# branches can be screenshotted before and after.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: build.sh <dir>" >&2; exit 1; }
DIR=$1
[[ "$DIR" != "/" && "$DIR" != "$HOME" ]] || { echo "build.sh: refusing to rebuild $DIR" >&2; exit 1; }
rm -rf "$DIR"; mkdir -p "$DIR"; cd "$DIR"
git init -q -b main
git config user.email fixture@example.com; git config user.name fixture
w() { mkdir -p "$(dirname "$1")"; cat >"$1"; }

# ---------------------------------------------------------------- main
w package.json <<'EOF'
{ "name": "shop-api", "version": "1.0.0", "private": true, "scripts": { "test": "node --test", "start": "node server.js" } }
EOF
w CLAUDE.md <<'EOF'
# shop-api
Plain Node, CommonJS, no dependencies. Tests: `npm test` (node:test).
Route handlers take (store, query) and return plain objects.
Admin pages: `npm start` (PORT, default 3000) serves /orders and /customers,
rendered by src/views/pages.js. Every value put into HTML goes through esc().
EOF
w src/lib/paginate.js <<'EOF'
// Returns one page of items. `page` is 1-based.
function paginate(items, page, size) {
  const start = (page - 1) * size
  return items.slice(start, start + size)
}

function pageCount(total, size) {
  return Math.ceil(total / size)
}

module.exports = { paginate, pageCount }
EOF
w src/lib/config.js <<'EOF'
const fs = require('fs')
const path = require('path')

function loadConfig(name) {
  const file = path.join(__dirname, '..', '..', 'config', name)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

module.exports = { loadConfig }
EOF
w src/lib/format.js <<'EOF'
function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`
}

module.exports = { formatPrice }
EOF
w src/store.js <<'EOF'
function createStore(seed = {}) {
  const data = { orders: seed.orders || [], customers: seed.customers || [] }
  return {
    orders: () => data.orders.slice(),
    customers: () => data.customers.slice()
  }
}

module.exports = { createStore }
EOF
w src/routes/orders.js <<'EOF'
const { paginate, pageCount } = require('../lib/paginate')
const { formatPrice } = require('../lib/format')

function listOrders(store, query = {}) {
  const page = Number(query.page) || 1
  const size = Number(query.size) || 20
  const all = store.orders()
  return {
    items: paginate(all, page, size).map(o => ({ ...o, price: formatPrice(o.cents) })),
    pages: pageCount(all.length, size)
  }
}

module.exports = { listOrders }
EOF
w src/routes/customers.js <<'EOF'
const { paginate } = require('../lib/paginate')

function listCustomers(store, query = {}) {
  const page = Number(query.page) || 1
  const size = Number(query.size) || 50
  return { items: paginate(store.customers(), page, size) }
}

module.exports = { listCustomers }
EOF
w config/statuses.json <<'EOF'
{ "statuses": ["pending", "paid", "shipped", "cancelled"] }
EOF
w test/paginate.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { paginate, pageCount } = require('../src/lib/paginate')

test('first page', () => assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), [1, 2]))
test('last partial page', () => assert.deepEqual(paginate([1, 2, 3, 4, 5], 3, 2), [5]))
test('page count rounds up', () => assert.equal(pageCount(5, 2), 3))
EOF
w test/orders.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStore } = require('../src/store')
const { listOrders } = require('../src/routes/orders')

const store = createStore({ orders: [{ id: 1, cents: 1250, status: 'paid' }, { id: 2, cents: 99, status: 'pending' }] })

test('lists orders with formatted prices', () => {
  const res = listOrders(store, { page: 1, size: 10 })
  assert.deepEqual(res.items.map(o => o.price), ['$12.50', '$0.99'])
  assert.equal(res.pages, 1)
})
EOF
# Admin frontend: two server-rendered pages and one stylesheet.
w src/lib/html.js <<'EOF'
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Escapes a value for use in HTML text or attributes.
function esc(value) {
  return String(value).replace(/[&<>"']/g, c => MAP[c])
}

module.exports = { esc }
EOF
w src/views/pages.js <<'EOF'
const { esc } = require('../lib/html')
const { listOrders } = require('../routes/orders')
const { listCustomers } = require('../routes/customers')

function layout(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · Shop admin</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><h1>Shop admin</h1><nav><a href="/orders">Orders</a><a href="/customers">Customers</a></nav></header>
<main><h2>${esc(title)}</h2>${body}</main></body></html>`
}

function renderOrders(store, query = {}) {
  const { items } = listOrders(store, query)
  const rows = items.map(o =>
    `<tr><td>#${esc(o.id)}</td><td>${esc(o.price)}</td><td>${esc(o.status)}</td></tr>`).join('')
  return layout('Orders', `<table class="list"><thead><tr><th>Order</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`)
}

function renderCustomers(store, query = {}) {
  const { items } = listCustomers(store, query)
  const rows = items.map(c =>
    `<li><span class="name">${esc(c.name)}</span>${c.vip ? ' <span class="badge">VIP</span>' : ''}</li>`).join('')
  return layout('Customers', `<ul class="customers">${rows}</ul>`)
}

module.exports = { renderOrders, renderCustomers }
EOF
w server.js <<'EOF'
const http = require('http')
const fs = require('fs')
const path = require('path')
const { createStore } = require('./src/store')
const { renderOrders, renderCustomers } = require('./src/views/pages')

const store = createStore(require('./seed.json'))
const pages = { '/orders': renderOrders, '/customers': renderCustomers }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/styles.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'styles.css')))
  }
  const render = pages[url.pathname === '/' ? '/orders' : url.pathname]
  if (!render) { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(render(store, Object.fromEntries(url.searchParams)))
})

server.listen(Number(process.env.PORT) || 3000, () => console.log(`listening on ${server.address().port}`))
EOF
w seed.json <<'EOF'
{
  "orders": [
    { "id": 1001, "cents": 4250, "status": "paid" },
    { "id": 1002, "cents": 1999, "status": "pending" },
    { "id": 1003, "cents": 12000, "status": "shipped" },
    { "id": 1004, "cents": 850, "status": "cancelled" },
    { "id": 1005, "cents": 3100, "status": "paid" }
  ],
  "customers": [
    { "id": 1, "name": "Acme Corporation", "vip": true },
    { "id": 2, "name": "Globex Industries", "vip": false },
    { "id": 3, "name": "Initech", "vip": true },
    { "id": 4, "name": "Umbrella Supplies", "vip": false }
  ]
}
EOF
w public/styles.css <<'EOF'
body { margin: 0; font: 15px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1f2328; background: #f6f8fa; }
header { display: flex; align-items: center; gap: 32px; padding: 12px 24px; background: #24292f; color: #fff; }
header h1 { margin: 0; font-size: 17px; }
nav a { color: #c9d1d9; margin-right: 16px; text-decoration: none; }
main { padding: 24px; }
main h2 { margin-top: 0; }
table.list { border-collapse: collapse; background: #fff; min-width: 420px; }
table.list th, table.list td { padding: 8px 16px; border-bottom: 1px solid #d0d7de; text-align: left; }
ul.customers { list-style: none; margin: 0; padding: 0; max-width: 420px; background: #fff; }
ul.customers li { padding: 10px 16px; border-bottom: 1px solid #d0d7de; }
.badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #fff8c5; color: #7d4e00; border: 1px solid #d4a72c; }
EOF
w test/views.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStore } = require('../src/store')
const { renderOrders, renderCustomers } = require('../src/views/pages')

const store = createStore({
  orders: [{ id: 1, cents: 1250, status: 'paid' }],
  customers: [{ id: 1, name: 'Acme <Corp>', vip: true }, { id: 2, name: 'Globex', vip: false }]
})

// Kept away from pagination and price formatting, which other fixture
// branches change on purpose: their planted defects are for review to find.
test('orders page lists order ids', () => assert.match(renderOrders(store), /#1</))
test('pages use the shared stylesheet', () => assert.match(renderCustomers(store), /href="\/styles\.css"/))
EOF
git add -A; git commit -qm 'Initial shop API'

# ------------------------------------------- feature/order-filters (defects)
git switch -qc feature/order-filters
w src/lib/paginate.js <<'EOF'
// Returns one page of items. `page` is 0-based.
function paginate(items, page, size) {
  const start = page * size
  return items.slice(start, start + size)
}

function pageCount(total, size) {
  return Math.ceil(total / size)
}

module.exports = { paginate, pageCount }
EOF
w src/lib/format.js <<'EOF'
function formatPrice(cents) {
  return `$${Math.round(cents / 100)}`
}

module.exports = { formatPrice }
EOF
w src/routes/orders.js <<'EOF'
const { paginate, pageCount } = require('../lib/paginate')
const { formatPrice } = require('../lib/format')
const { loadConfig } = require('../lib/config')

function allowedStatuses() {
  try {
    return loadConfig('order-statuses.json').statuses
  } catch (e) {
    return []
  }
}

function listOrders(store, query = {}) {
  const page = Number(query.page) || 0
  const size = Number(query.size) || 20
  let all = store.orders()
  if (query.status) {
    const allowed = allowedStatuses()
    all = all.filter(o => allowed.includes(query.status) && o.status === query.status)
  }
  return {
    items: paginate(all, page, size).map(o => ({ ...o, price: formatPrice(o.cents) })),
    pages: pageCount(all.length, size)
  }
}

module.exports = { listOrders }
EOF
w test/paginate.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { paginate, pageCount } = require('../src/lib/paginate')

test('first page', () => assert.deepEqual(paginate([1, 2, 3, 4, 5], 0, 2), [1, 2]))
test('last partial page', () => assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [5]))
test('page count rounds up', () => assert.equal(pageCount(5, 2), 3))
EOF
w test/orders.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStore } = require('../src/store')
const { listOrders } = require('../src/routes/orders')

const store = createStore({ orders: [{ id: 1, cents: 1250, status: 'paid' }, { id: 2, cents: 99, status: 'pending' }] })

test('lists orders with formatted prices', () => {
  const res = listOrders(store, { page: 0, size: 10 })
  assert.deepEqual(res.items.map(o => o.price), ['$13', '$1'])
  assert.equal(res.pages, 1)
})

test('filters by status', () => {
  const mock = { orders: () => [{ id: 1, cents: 1250, status: 'paid' }] }
  const res = listOrders(mock, { status: 'paid' })
  assert.ok(Array.isArray(res.items))
})
EOF
git add -A; git commit -qm 'Add status filter to order listing'
git commit -q --allow-empty -m 'Zero-based pages for the new UI'

# ------------------------------------------- feature/order-count (clean)
git switch -q main
git switch -qc feature/order-count
w src/routes/orders.js <<'EOF'
const { paginate, pageCount } = require('../lib/paginate')
const { formatPrice } = require('../lib/format')

function listOrders(store, query = {}) {
  const page = Number(query.page) || 1
  const size = Number(query.size) || 20
  const all = store.orders()
  return {
    items: paginate(all, page, size).map(o => ({ ...o, price: formatPrice(o.cents) })),
    pages: pageCount(all.length, size)
  }
}

// Number of orders, optionally only those with the given status.
function countOrders(store, query = {}) {
  const all = store.orders()
  const count = query.status ? all.filter(o => o.status === query.status).length : all.length
  return { count }
}

module.exports = { listOrders, countOrders }
EOF
w test/orders.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createStore } = require('../src/store')
const { listOrders, countOrders } = require('../src/routes/orders')

const store = createStore({ orders: [{ id: 1, cents: 1250, status: 'paid' }, { id: 2, cents: 99, status: 'pending' }] })

test('lists orders with formatted prices', () => {
  const res = listOrders(store, { page: 1, size: 10 })
  assert.deepEqual(res.items.map(o => o.price), ['$12.50', '$0.99'])
  assert.equal(res.pages, 1)
})

test('counts all orders', () => assert.deepEqual(countOrders(store), { count: 2 }))
test('counts orders with a status', () => assert.deepEqual(countOrders(store, { status: 'paid' }), { count: 1 }))
test('unknown status counts zero', () => assert.deepEqual(countOrders(store, { status: 'lost' }), { count: 0 }))
EOF
git add -A; git commit -qm 'Add order count endpoint'

# ------------------------------------- feature/order-status-badge (UI defects)
git switch -q main
git switch -qc feature/order-status-badge
w src/views/pages.js <<'EOF'
const { esc } = require('../lib/html')
const { listOrders } = require('../routes/orders')
const { listCustomers } = require('../routes/customers')

function layout(title, body) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · Shop admin</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><h1>Shop admin</h1><nav><a href="/orders">Orders</a><a href="/customers">Customers</a></nav></header>
<main><h2>${esc(title)}</h2>${body}</main></body></html>`
}

function statusBadge(status) {
  return `<span class="badge status-${status}">${status}</span>`
}

function renderOrders(store, query = {}) {
  const { items } = listOrders(store, query)
  const rows = items.map(o =>
    `<tr><td>#${esc(o.id)}</td><td>${esc(o.price)}</td><td>${statusBadge(o.status)}</td></tr>`).join('')
  return layout('Orders', `<table class="list"><thead><tr><th>Order</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`)
}

function renderCustomers(store, query = {}) {
  const { items } = listCustomers(store, query)
  const rows = items.map(c =>
    `<li><span class="name">${esc(c.name)}</span>${c.vip ? ' <span class="badge">VIP</span>' : ''}</li>`).join('')
  return layout('Customers', `<ul class="customers">${rows}</ul>`)
}

module.exports = { renderOrders, renderCustomers }
EOF
cat >>public/styles.css <<'EOF'

/* Order status badges */
.badge { display: block; width: 88px; margin: 0; padding: 3px 0; border: 0; border-radius: 4px; text-align: center; font-weight: 600; text-transform: uppercase; color: #fff; }
.status-paid { background: #1a7f37; }
.status-pending { background: #9a6700; }
.status-shipped { background: #0969da; }
.status-cancelled { background: #cf222e; }
EOF
cat >>test/views.test.js <<'EOF'
test('orders page shows a status badge', () => assert.match(renderOrders(store), /class="badge status-paid">paid</))
EOF
git add -A; git commit -qm 'Show order status as a colored badge'
git switch -q main
echo "fixture ready: $DIR"
