#!/usr/bin/env bash
# Builds the evaluation fixture: a small Node API repo whose branches are the
# test cases. The answer key for each branch is in ../expected.json; its PR
# description and ticket are in descriptions/<branch-name>.md and .issue.md.
#
#   bash build.sh <dir>        # <dir> is deleted and rebuilt
#
# Branches:
#   feature/order-filters  four planted defects (see expected.json)
#   feature/order-count    clean
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
{ "name": "shop-api", "version": "1.0.0", "private": true, "scripts": { "test": "node --test" } }
EOF
w CLAUDE.md <<'EOF'
# shop-api
Plain Node, CommonJS, no dependencies. Tests: `npm test` (node:test).
Route handlers take (store, query) and return plain objects.
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
git switch -q main
echo "fixture ready: $DIR"
