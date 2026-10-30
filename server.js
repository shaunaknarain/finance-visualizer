// Personal finance visualizer — Express app with a single-password gate,
// Plaid bank linking, and a Mint-style dashboard. Falls back to demo data
// when no Plaid keys are configured.
//
//   1. cp ".env.example" .env   (then fill it in)
//   2. npm install
//   3. npm start
//   4. open http://localhost:4000
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const plaid = require("./lib/plaid");
const store = require("./lib/store");
const demo = require("./lib/demo");
const staticImport = require("./lib/staticImport");
const { buildOverview, normalizeHoldings } = require("./lib/finance");

const PORT = parseInt(process.env.FINANCE_PORT || "4000", 10);
const DEMO_MODE = !plaid.configured; // no Plaid keys => show demo data
// Set AUTH_DISABLED=1 in .env to skip the login gate (local dev only —
// NEVER run this with real Plaid data on a public host).
const AUTH_DISABLED = /^(1|true)$/i.test(process.env.AUTH_DISABLED || "");

// Cache the (slow, Plaid-backed) overview so repeat loads are instant.
let overviewCache = { at: 0, data: null };
const OVERVIEW_TTL = Math.max(1, parseInt(process.env.OVERVIEW_CACHE_MINUTES || "30", 10)) * 60 * 1000;
function invalidateOverview() { overviewCache = { at: 0, data: null }; }

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true once you serve this over HTTPS
      maxAge: 1000 * 60 * 60 * 12, // 12h
    },
  })
);

// ---------- auth ----------
function checkPassword(input) {
  const expected = process.env.FINANCE_PASSWORD || "";
  if (!expected || !input) return false;
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (AUTH_DISABLED) return next();
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  return res.redirect("/login");
}

app.post("/login", (req, res) => {
  if (checkPassword(req.body.password)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Wrong password" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Public assets (login page + shared css/js — no secrets in these).
const PUBLIC = path.join(__dirname, "public");
// no-store so rapid iterations always reach the browser (no stale cache)
const noCache = (res) => res.set("Cache-Control", "no-store");
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC, "login.html")));
app.get("/finance.css", (req, res) => { noCache(res); res.sendFile(path.join(PUBLIC, "finance.css")); });
app.get("/finance.js", (req, res) => { noCache(res); res.sendFile(path.join(PUBLIC, "finance.js")); });

// Everything below requires a session.
app.use(requireAuth);

app.get("/", (req, res) => res.redirect("/app"));
app.get("/app", (req, res) => res.sendFile(path.join(PUBLIC, "dashboard.html")));

// Tells the frontend whether we're in demo mode and how many banks are linked.
app.get("/api/status", (req, res) => {
  res.json({
    demo: DEMO_MODE,
    env: plaid.PLAID_ENV,
    authDisabled: AUTH_DISABLED,
    linkedBanks: DEMO_MODE ? 0 : store.listItems().length,
  });
});

// ---------- Plaid linking ----------
app.post("/api/plaid/create_link_token", async (req, res) => {
  if (DEMO_MODE) return res.status(400).json({ error: "demo", message: "Add Plaid keys to .env to link a real bank." });
  try {
    // { item_id } => update mode for a bank whose login expired
    const itemId = req.body?.item_id;
    const item = itemId ? store.getItem(itemId) : null;
    if (itemId && !item) return res.status(404).json({ error: "unknown_item", message: "That bank isn't linked." });
    const link_token = await plaid.createLinkToken("local-user", item?.access_token);
    res.json({ link_token });
  } catch (e) {
    console.error("create_link_token:", e.response?.data || e.message);
    res.status(500).json({ error: "plaid_error", message: e.response?.data?.error_message || e.message });
  }
});

app.post("/api/plaid/exchange_public_token", async (req, res) => {
  if (DEMO_MODE) return res.status(400).json({ error: "demo" });
  try {
    const { access_token, item_id } = await plaid.exchangePublicToken(req.body.public_token);
    const institution_name = await plaid.getInstitutionName(access_token);
    store.addItem({ access_token, item_id, institution_name });
    invalidateOverview();
    res.json({ ok: true });
  } catch (e) {
    console.error("exchange_public_token:", e.response?.data || e.message);
    res.status(500).json({ error: "plaid_error", message: e.response?.data?.error_message || e.message });
  }
});

app.post("/api/plaid/remove/:itemId", (req, res) => {
  store.removeItem(req.params.itemId);
  invalidateOverview();
  res.json({ ok: true });
});

// Save a friendly name for an account (empty name clears it).
app.post("/api/finance/nickname", (req, res) => {
  const { account_id, name } = req.body || {};
  if (!account_id) return res.status(400).json({ error: "account_id required" });
  store.setNickname(account_id, name);
  invalidateOverview();
  res.json({ ok: true });
});

// ---------- the data the dashboard renders ----------
function applyNicknames(accounts) {
  const nicks = store.loadNicknames();
  for (const a of accounts) a.nickname = nicks[a.account_id] || null;
}

// Pulls live data from Plaid (all items + all 3 calls per item in parallel),
// merges static accounts, and computes the overview payload.
async function computeLiveOverview() {
  const items = store.listItems();

  // A bank that needs a re-login shouldn't take down the whole dashboard:
  // fall back to its last good snapshot and flag it for reconnecting.
  const needsReconnect = [];
  const perItem = await Promise.all(
    items.map(async (item) => {
      try {
        const [accts, holdings, delta] = await Promise.all([
          plaid.getAccounts(item.access_token),
          plaid.getHoldings(item.access_token),
          plaid.syncTransactions(item.access_token, item.cursor),
        ]);
        store.applyTransactionDelta(item.item_id, delta);
        store.saveItemSnapshot(item.item_id, { accounts: accts, holdings });
        return {
          accounts: accts.map((a) => ({ ...a, institution: item.institution_name })),
          holdings: holdings ? { ...holdings, institution: item.institution_name } : null,
        };
      } catch (e) {
        if (!plaid.needsRelink(e)) throw e;
        needsReconnect.push({
          item_id: item.item_id,
          institution: item.institution_name,
          lastSync: item.last_sync_at || null,
        });
        const accts = item.last_accounts || [];
        return {
          accounts: accts.map((a) => ({ ...a, institution: item.institution_name })),
          holdings: item.last_holdings ? { ...item.last_holdings, institution: item.institution_name } : null,
        };
      }
    })
  );

  const accounts = [];
  const holdingSources = [];
  for (const r of perItem) {
    accounts.push(...r.accounts);
    if (r.holdings) holdingSources.push(r.holdings);
  }

  let transactions = [];
  for (const item of store.listItems()) transactions = transactions.concat(item.transactions || []);

  // merge in any static (manual snapshot) accounts, e.g. a bank imported from CSV
  const stat = staticImport.loadStatic();
  accounts.push(...stat.accounts);
  transactions = transactions.concat(stat.transactions);

  const ov = buildOverview(accounts, transactions);
  applyNicknames(ov.accounts);
  return { demo: false, linkedBanks: items.length, ...ov, holdings: normalizeHoldings(holdingSources), needsReconnect };
}

app.get("/api/finance/overview", async (req, res) => {
  try {
    // demo mode: no Plaid keys at all, OR a real user toggling the demo view
    // (?demo=1) to safely show off the dashboard with mock data.
    if (DEMO_MODE || req.query.demo === "1") {
      const ov = buildOverview(demo.accounts, demo.transactions);
      applyNicknames(ov.accounts);
      return res.json({ demo: true, ...ov, holdings: normalizeHoldings(demo.holdingSources) });
    }

    // serve fresh-enough cached data instantly (bypass with ?refresh=1)
    if (req.query.refresh !== "1" && overviewCache.data && Date.now() - overviewCache.at < OVERVIEW_TTL) {
      return res.json({ ...overviewCache.data, cached: true });
    }

    const payload = await computeLiveOverview();
    overviewCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    console.error("overview:", e.response?.data || e.message);
    // A transient bank/Plaid outage shouldn't blank the dashboard. If we have
    // any prior snapshot, serve it marked stale rather than hard-failing.
    if (overviewCache.data) {
      return res.json({
        ...overviewCache.data,
        cached: true,
        stale: true,
        staleSince: overviewCache.at,
        warning: e.response?.data?.error_message || e.message,
      });
    }
    res.status(500).json({ error: "plaid_error", message: e.response?.data?.error_message || e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Finance visualizer → http://localhost:${PORT}`);
  console.log(`  Mode: ${DEMO_MODE ? "DEMO (no Plaid keys)" : `LIVE / ${plaid.PLAID_ENV}`}`);
  console.log(`  Auth: ${AUTH_DISABLED ? "DISABLED (no login)" : "password gate on"}`);
  // pre-warm the overview cache so the first page load is instant
  if (!DEMO_MODE && store.listItems().length) {
    computeLiveOverview()
      .then((p) => { overviewCache = { at: Date.now(), data: p }; console.log("  ✓ Overview cache pre-warmed"); })
      .catch((e) => console.error("  prewarm failed:", e.response?.data?.error_message || e.message));
  }
  if (!process.env.FINANCE_PASSWORD) {
    console.log("  ⚠  No FINANCE_PASSWORD set — login will reject everything. Add one to .env.\n");
  } else {
    console.log("");
  }
});
