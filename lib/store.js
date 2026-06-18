// Tiny JSON-file store for Plaid items (one per connected bank).
// Lives in ./data/store.json which is gitignored. Holds access tokens +
// a transactions cache + the sync cursor so we don't re-pull everything.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const NICK_PATH = path.join(DATA_DIR, "nicknames.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return { items: {} };
  }
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function listItems() {
  return Object.values(load().items);
}

function getItem(itemId) {
  return load().items[itemId] || null;
}

// Insert a freshly linked bank.
function addItem({ item_id, access_token, institution_name }) {
  const state = load();
  state.items[item_id] = {
    item_id,
    access_token,
    institution_name: institution_name || "Bank",
    cursor: null,
    transactions: [],
    linked_at: Date.now(),
  };
  save(state);
}

function removeItem(itemId) {
  const state = load();
  delete state.items[itemId];
  save(state);
}

// Apply a transactionsSync delta to the cached transaction list for one item.
function applyTransactionDelta(itemId, { added, modified, removed, cursor }) {
  const state = load();
  const item = state.items[itemId];
  if (!item) return;

  const byId = new Map((item.transactions || []).map((t) => [t.transaction_id, t]));
  for (const t of added) byId.set(t.transaction_id, t);
  for (const t of modified) byId.set(t.transaction_id, t);
  for (const r of removed) byId.delete(r.transaction_id);

  item.transactions = [...byId.values()];
  item.cursor = cursor;
  item.last_sync_at = new Date().toISOString();
  save(state);
}

// ---- account nicknames (account_id -> friendly name) ----
function loadNicknames() {
  try {
    return JSON.parse(fs.readFileSync(NICK_PATH, "utf8"));
  } catch {
    return {};
  }
}

function setNickname(accountId, name) {
  const nicks = loadNicknames();
  const trimmed = (name || "").trim();
  if (trimmed) nicks[accountId] = trimmed;
  else delete nicks[accountId]; // empty name clears it
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NICK_PATH, JSON.stringify(nicks, null, 2));
  return nicks;
}

module.exports = {
  STORE_PATH,
  listItems,
  getItem,
  addItem,
  removeItem,
  applyTransactionDelta,
  loadNicknames,
  setNickname,
};
