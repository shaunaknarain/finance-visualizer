// Dashboard logic: load status, render overview, wire up Plaid Link.
const $ = (id) => document.getElementById(id);
const fmt = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

const CHART_COLORS = [
  "#0f172a", "#16a34a", "#3b82f6", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#64748b", "#84cc16",
];

let catChart, trendChart;
let lastOverview = null;
let spendRange = "month"; // "week" | "month" | "halfyear"
let donutGroup = null; // null = top-level groups; else the group we've drilled into
let donutCategory = null; // null = group's categories; else the leaf category we've opened
let donutItems = [], donutTotal = 0, donutDrilled = false; // for the custom tooltip
// demo shows obviously-fake "Demo Bank" data. Toggleable + remembered.
let demoView =
  new URLSearchParams(location.search).get("demo") === "1" || localStorage.getItem("demoView") === "1";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
  return res.json();
}

async function init() {
  // logout
  $("logout-btn").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    window.location.href = "/login";
  });

  let status;
  try {
    status = await getJSON("/api/status");
  } catch {
    window.location.href = "/login";
    return;
  }

  // hide logout when the login gate is turned off
  if (status.authDisabled) $("logout-btn").hidden = true;

  // demo badge + connect button behavior
  const badge = $("mode-badge");
  if (status.demo) {
    badge.textContent = "Demo data";
    badge.classList.add("demo");
  } else {
    badge.textContent = status.env;
  }
  $("connect-btn").addEventListener("click", connectBank);
  $("connect-btn-empty").addEventListener("click", connectBank);

  // demo toggle — shows obviously-fake "Demo Bank" data for showing people
  const demoBtn = $("demo-toggle");
  const syncDemo = () => {
    demoBtn.classList.toggle("is-on", demoView);
    demoBtn.setAttribute("aria-pressed", demoView ? "true" : "false");
    if (!status.demo) {
      badge.textContent = demoView ? "Demo data" : status.env;
      badge.classList.toggle("demo", demoView);
    }
  };
  syncDemo();
  demoBtn.addEventListener("click", async () => {
    demoView = !demoView;
    localStorage.setItem("demoView", demoView ? "1" : "0");
    syncDemo();
    await loadOverview();
  });

  // overview / details tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.hidden = p.id !== "tab-" + tab;
      });
    });
  });

  // spending range toggle
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      spendRange = btn.dataset.range;
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      donutGroup = null;
      donutCategory = null;
      if (lastOverview) renderDonut();
    });
  });

  await loadOverview();
}

async function loadOverview() {
  $("loading").hidden = false;
  $("content").hidden = true;
  $("content").classList.remove("is-ready");
  $("empty").hidden = true;

  let data;
  try {
    data = await getJSON("/api/finance/overview" + (demoView ? "?demo=1" : ""));
  } catch (e) {
    $("loading").textContent = "Couldn't load data: " + e.message;
    return;
  }

  // live mode with no linked banks -> empty state
  if (!data.demo && (!data.accounts || data.accounts.length === 0)) {
    $("loading").hidden = true;
    $("empty").hidden = false;
    return;
  }

  try {
    render(data);
  } catch (e) {
    console.error("render overview:", e);
    showLoadError(e);
    return;
  }
  $("loading").hidden = true;
  $("content").hidden = false;
  animateDashboard();
}

function showLoadError(e) {
  const loading = $("loading");
  loading.hidden = false;
  loading.innerHTML = `
    <div class="loading-card loading-error">
      <div class="loading-kicker">Finance</div>
      <div class="loading-title">Couldn't render the dashboard</div>
      <div class="loading-note">${escapeHtml(e && e.message ? e.message : "Refresh and try again.")}</div>
    </div>`;
}

function render(d) {
  lastOverview = d;
  $("net-worth").textContent = fmt(d.netWorth);
  $("net-worth").classList.toggle("neg", d.netWorth < 0);
  $("total-assets").textContent = fmt(d.assets);
  $("cash").textContent = fmt(d.cash);
  $("invested-inline").textContent = fmt(d.investments);
  $("liabilities").textContent = fmt(d.liabilities);

  // last-30d spend (matches the donut center)
  const spend30 = (d.categories || []).reduce((s, c) => s + c.amount, 0);
  $("month-spend").textContent = fmt(spend30);

  // this calendar month income / net
  const tm = d.trend && d.trend.length ? d.trend[d.trend.length - 1] : { income: 0, spend: 0 };
  const net = tm.income - tm.spend;
  $("income-month").textContent = fmt(tm.income);
  $("net-month").textContent = (net >= 0 ? "+" : "−") + fmt(Math.abs(net));
  $("net-month").className = "stat-value " + (net >= 0 ? "pos" : "neg");

  renderPaycheck(d.paycheck);
  renderVenmo(d.venmo);
  renderServices(d.services);
  renderSubscriptions(d.subscriptions);
  renderSplit(d.housing);
  renderHoldings(d.holdings);
  renderAccounts(d.accounts);
  renderTxns(d.recent);
  donutGroup = null;
  donutCategory = null;
  renderDonut();
  renderTrendChart(d.trend);
}

function animateDashboard() {
  const content = $("content");
  const animated = content.querySelectorAll(".card, .callout");
  animated.forEach((el, i) => {
    el.style.setProperty("--enter-delay", `${Math.min(i * 42, 360)}ms`);
  });

  content.querySelectorAll(".txn-row, .acct-row, .venmo-row").forEach((el, i) => {
    el.style.setProperty("--row-delay", `${Math.min(i * 24, 220)}ms`);
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => content.classList.add("is-ready"));
  });
}

function currentCategories() {
  if (!lastOverview) return [];
  const byRange = lastOverview.categoriesByRange;
  return (byRange && byRange[spendRange]) || lastOverview.categories || [];
}

function renderServices(services) {
  const el = $("service-list");
  if (!el) return;
  el.innerHTML = "";
  for (const s of services || []) {
    const row = document.createElement("div");
    row.className = "service-row";
    const isStatic = s.status === "Static";
    row.innerHTML = `
      <span class="service-icon ${serviceTone(s.name)}">${serviceIcon(s.name)}</span>
      <span class="service-main">
        <span class="service-name">${escapeHtml(serviceLabel(s.name))}</span>
        <span class="service-sub">${escapeHtml(isStatic ? "Manual snapshot" : "Connected")}</span>
      </span>
      <span class="service-meta">
        <span class="service-pill ${isStatic ? "is-static" : "is-live"}">${escapeHtml(s.status)}</span>
        <span class="service-date">${s.lastUpdate ? shortDate(s.lastUpdate) : "No updates"}</span>
      </span>`;
    el.appendChild(row);
  }
}

// Subscriptions & recurring bills — lives in the Details tab. Each row reuses
// the txn-row layout (category icon · name · cadence/last-charge · monthly cost).
function renderSubscriptions(subs) {
  const el = $("subs-list");
  if (!el) return;
  const items = (subs && subs.items) || [];
  const totalEl = $("subs-total");
  if (totalEl) {
    totalEl.textContent = items.length ? `· ${fmt(subs.monthlyTotal)}/mo · ${fmt(subs.yearlyTotal)}/yr` : "";
  }
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML =
      `<div class="subs-empty">No recurring subscriptions found in the linked accounts yet. ` +
      `They'll appear here once a charge repeats — or matches a known service like Netflix, Spotify, or your internet bill.</div>`;
    return;
  }
  for (const s of items) {
    const cadence = s.cadence ? s.cadence.charAt(0).toUpperCase() + s.cadence.slice(1) : "Recurring";
    const sub = [cadence, s.lastDate ? "last " + shortDate(s.lastDate) : null, s.category]
      .filter(Boolean)
      .map(escapeHtml)
      .join(" · ");
    const row = document.createElement("div");
    row.className = "txn-row";
    row.innerHTML = `
      <span class="txn-icon ${iconTone(s.category, false)}">${categoryIcon(s.category, false)}</span>
      <div class="txn-left">
        <span class="txn-name">${escapeHtml(s.name)}</span>
        <span class="txn-cat">${sub}</span>
      </div>
      <span class="txn-amt">${fmt(s.monthly)}<span class="subs-permo">/mo</span></span>`;
    el.appendChild(row);
  }
}

// Housing splitter (Details tab): pick the housing purchases to share, set the
// roommate + their %, and fire off a prefilled Venmo charge. Selection/handle
// persist in localStorage so it's one tap each month.
let lastHousing = [];

function renderSplit(housing) {
  lastHousing = (housing || []).slice();
  const el = $("split");
  if (!el) return;
  const shareEl = $("split-share");
  if (!lastHousing.length) {
    el.innerHTML =
      `<div class="split-empty">No housing purchases (rent, utilities, furniture) in the last 60 days to split.</div>`;
    if (shareEl) shareEl.textContent = "";
    return;
  }

  const handle = localStorage.getItem("splitHandle") || "";
  const pct = localStorage.getItem("splitPct") || "50";
  el.innerHTML = `
    <div class="split-controls">
      <label class="split-field">
        <span class="split-lbl">Roommate's Venmo</span>
        <input id="split-handle" class="split-input" type="text" autocomplete="off" spellcheck="false" placeholder="@username" value="${escapeHtml(handle)}">
      </label>
      <label class="split-field split-field-pct">
        <span class="split-lbl">Their share</span>
        <span class="split-pctwrap"><input id="split-pct" class="split-input" type="number" min="0" max="100" step="5" value="${escapeHtml(pct)}"><span class="split-pct-sign">%</span></span>
      </label>
    </div>
    <div class="split-list">
      ${lastHousing
        .map(
          (h) => `
        <label class="split-row">
          <input type="checkbox" class="split-check" data-id="${escapeHtml(h.id)}" checked>
          <span class="split-checkbox" aria-hidden="true"></span>
          <span class="txn-icon ${iconTone(h.category, false)}">${categoryIcon(h.category, false)}</span>
          <span class="txn-left">
            <span class="txn-name">${escapeHtml(displayTxnName(h))}</span>
            <span class="txn-cat">${escapeHtml(h.category)} · ${escapeHtml(shortDate(h.date))}</span>
          </span>
          <span class="txn-amt">${fmt(h.amount)}</span>
        </label>`
        )
        .join("")}
    </div>
    <div class="split-summary">
      <div class="split-totals">
        <div class="split-tot"><span class="split-lbl">Selected</span><b id="split-total">—</b></div>
        <div class="split-tot"><span class="split-lbl">They owe</span><b id="split-owe" class="split-owe">—</b></div>
      </div>
      <a id="split-btn" class="venmo-btn" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.6 4.6c.6 1 .86 2.06.86 3.4 0 4.25-3.63 9.78-6.57 13.66H7.3L4.66 5.43l5.83-.55 1.4 11.27c1.3-2.13 2.92-5.48 2.92-7.77 0-1.25-.22-2.1-.55-2.8L19.6 4.6Z"/></svg>
        <span id="split-btn-text">Request on Venmo</span>
      </a>
    </div>`;

  el.querySelectorAll(".split-check").forEach((c) => c.addEventListener("change", recomputeSplit));
  $("split-handle").addEventListener("input", () => {
    localStorage.setItem("splitHandle", $("split-handle").value.trim());
    recomputeSplit();
  });
  $("split-pct").addEventListener("input", () => {
    localStorage.setItem("splitPct", $("split-pct").value);
    recomputeSplit();
  });
  recomputeSplit();
}

function recomputeSplit() {
  const byId = {};
  for (const h of lastHousing) byId[h.id] = h;
  const selected = [];
  document.querySelectorAll(".split-check").forEach((c) => {
    if (c.checked && byId[c.dataset.id]) selected.push(byId[c.dataset.id]);
  });

  const total = selected.reduce((s, h) => s + h.amount, 0);
  const pctRaw = parseFloat(($("split-pct") || {}).value);
  const pct = Math.max(0, Math.min(100, isNaN(pctRaw) ? 50 : pctRaw));
  const owe = Math.round(total * pct) / 100;

  $("split-total").textContent = fmt(total);
  $("split-owe").textContent = fmt(owe);
  const shareEl = $("split-share");
  if (shareEl) shareEl.textContent = owe > 0 ? `· they owe ${fmt(owe)}` : "";

  const btn = $("split-btn");
  const btnText = $("split-btn-text");
  const handle = (($("split-handle") || {}).value || "").trim().replace(/^@+/, "");
  const cats = [...new Set(selected.map((h) => h.category))];
  const note = `Housing split (${Math.round(pct)}%) — ${cats.join(", ") || "shared costs"}`;

  if (owe > 0) {
    const params = new URLSearchParams({ txn: "charge", audience: "private", amount: owe.toFixed(2), note });
    if (handle) params.set("recipients", handle);
    btn.href = "https://venmo.com/?" + params.toString();
    btn.classList.remove("is-disabled");
    btn.removeAttribute("aria-disabled");
    if (btnText) btnText.textContent = `Request ${fmt(owe)} on Venmo`;
  } else {
    btn.removeAttribute("href");
    btn.classList.add("is-disabled");
    btn.setAttribute("aria-disabled", "true");
    if (btnText) btnText.textContent = "Request on Venmo";
  }
}

function serviceLabel(name) {
  const n = String(name);
  if (/venmo/i.test(n)) return "Venmo";
  return n;
}

function serviceTone(name) {
  const n = String(name).toLowerCase();
  if (/invest|brokerage/.test(n)) return "service-invest";
  if (n.includes("venmo")) return "service-venmo";
  return "service-bank";
}

function serviceIcon(name) {
  const n = String(name).toLowerCase();
  const attrs = `viewBox="0 0 24 24" aria-hidden="true"`;
  const common = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  if (/invest|brokerage/.test(n)) {
    return `<svg ${attrs}><path ${common} d="M4 19h16"/><path ${common} d="M7 16V8"/><path ${common} d="M12 16V5"/><path ${common} d="M17 16v-6"/></svg>`;
  }
  if (n.includes("venmo")) {
    return `<svg ${attrs}><path ${common} d="M7 5h4l2 9 4-9h4l-6 14h-4L7 5Z"/></svg>`;
  }
  return `<svg ${attrs}><path ${common} d="m3 10 9-6 9 6"/><path ${common} d="M5 10h14"/><path ${common} d="M6 10v8"/><path ${common} d="M10 10v8"/><path ${common} d="M14 10v8"/><path ${common} d="M18 10v8"/><path ${common} d="M4 18h16"/></svg>`;
}

function renderVenmo(v) {
  const card = $("venmo-card");
  if (!v || !v.recent || v.recent.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const wallet = v.wallet;
  $("venmo-current").hidden = !wallet;
  if (wallet) {
    const sub = [wallet.institution, wallet.mask ? "••" + wallet.mask : null].filter(Boolean).join(" · ");
    $("venmo-current-title").textContent = wallet.name || "Venmo wallet";
    $("venmo-current-wallet").textContent = sub || "Wallet balance";
    $("venmo-current-amount").textContent = fmt(wallet.balance || 0);
    $("venmo-current-amount").className = "venmo-current-amount";
  }

  const net = v.net30 || 0;
  $("venmo-sent").textContent = fmt(v.sent30 || 0);
  $("venmo-received").textContent = fmt(v.received30 || 0);
  $("venmo-net").textContent = (net >= 0 ? "+" : "−") + fmt(Math.abs(net));
  $("venmo-net").className = net >= 0 ? "pos" : "neg";

  const list = $("venmo-list");
  list.innerHTML = "";
  for (const t of (v.recent || []).slice(0, 5)) {
    const income = t.direction === "received";
    const row = document.createElement("div");
    row.className = "venmo-row";
    const title = t.originalName || t.name;
    const sub = [income ? "Received" : "Sent", shortDate(t.date)].filter(Boolean).map(escapeHtml).join(" · ");
    row.innerHTML = `
      <div class="venmo-row-main">
        <span class="venmo-row-title">${escapeHtml(title)}</span>
        <span class="venmo-row-sub">${sub}</span>
      </div>
      <span class="venmo-row-amt ${income ? "pos" : "neg"}">${income ? "+" : "−"}${fmt(t.amount)}</span>`;
    list.appendChild(row);
  }
}

function renderPaycheck(p) {
  const card = $("paycheck-callout");
  if (!p) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("pay-freq").textContent = p.checksPerMonth ? `· ~${p.checksPerMonth}×/month` : "";
  $("pay-check").textContent = fmt(p.avgCheck);
  $("pay-month").textContent = fmt(p.perMonth);
  $("pay-year").textContent = fmt(p.perYear);
  $("pay-note").textContent =
    `From ${p.count} deposits · most recent ${fmt(p.lastAmount)} on ${formatDate(p.lastDate)} · net take-home, not gross salary`;
}

function renderHoldings(holdings) {
  const card = $("holdings-card");
  if (!holdings || !holdings.rows || holdings.rows.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("holdings-total").textContent = "· " + fmt(holdings.total) + " total";
  const el = $("holdings-list");
  el.innerHTML = "";
  for (const h of holdings.rows) {
    const row = document.createElement("div");
    row.className = "acct-row";
    row.innerHTML = `
      <div class="acct-meta">
        <span class="acct-name">${escapeHtml(h.ticker || h.name)}</span>
        <span class="acct-sub">${escapeHtml(h.name)} · ${h.quantity} sh · ${escapeHtml(h.institution)}</span>
      </div>
      <span class="acct-bal">${fmt(h.value)}</span>`;
    el.appendChild(row);
  }
}

function renderAccounts(accounts) {
  const el = $("accounts-list");
  el.innerHTML = "";
  for (const a of accounts) {
    const row = document.createElement("div");
    row.className = "acct-row";

    const meta = document.createElement("div");
    meta.className = "acct-meta";
    meta.append(buildNameWrap(a));

    const sub = document.createElement("span");
    sub.className = "acct-sub";
    sub.textContent = `${a.institution} · ${a.subtype || a.type}${a.mask ? " ••" + a.mask : ""}`;
    meta.append(sub);

    // static (manual snapshot) accounts get a clear "not live" badge
    if (a.static) {
      const badge = document.createElement("span");
      badge.className = "acct-static";
      badge.textContent = "STATIC" + (a.asOf ? " · as of " + formatDate(a.asOf) : "");
      meta.append(badge);
    }

    // credit cards get a "last used" line so stale ones are obvious
    if (a.isCreditCard) {
      const lu = lastUsedText(a.lastUsed);
      const used = document.createElement("span");
      used.className = "acct-lastused" + (lu.stale ? " stale" : "");
      used.textContent = lu.text;
      meta.append(used);
    }

    const bal = document.createElement("span");
    bal.className = "acct-bal" + (a.isLiability ? " neg" : "");
    bal.textContent = (a.isLiability ? "−" : "") + fmt(a.balance);

    row.append(meta, bal);
    el.appendChild(row);
  }
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function lastUsedText(dateStr) {
  if (!dateStr) return { text: "No purchases yet", stale: true };
  const days = Math.floor((Date.now() - new Date(dateStr + "T00:00:00").getTime()) / 86400000);
  const rel = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return { text: "Last used " + rel, stale: days >= 30 };
}

// Name + ✎ pencil; clicking either opens an inline rename. Saved locally.
function buildNameWrap(account) {
  const wrap = document.createElement("div");
  wrap.className = "acct-name-wrap";

  const name = document.createElement("span");
  name.className = "acct-name editable";
  name.title = "Click to rename";
  name.textContent = account.nickname || account.name;

  const pencil = document.createElement("span");
  pencil.className = "edit-icon";
  pencil.textContent = "✎";
  pencil.title = "Rename";

  const start = () => editNickname(wrap, account);
  name.addEventListener("click", start);
  pencil.addEventListener("click", start);

  wrap.append(name, pencil);
  return wrap;
}

function editNickname(wrap, account) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "nick-input";
  input.value = account.nickname || account.name;
  wrap.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const name = input.value.trim();
      account.nickname = name || null;
      try {
        await fetch("/api/finance/nickname", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: account.account_id, name }),
        });
      } catch {}
    }
    wrap.replaceWith(buildNameWrap(account));
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function accountLabel(accountId) {
  if (!accountId || !lastOverview) return null;
  const a = (lastOverview.accounts || []).find((x) => x.account_id === accountId);
  if (!a) return null;
  return (a.nickname || a.name) + (a.mask ? " ••" + a.mask : "");
}

function renderTxns(txns) {
  const el = $("txn-list");
  el.innerHTML = "";
  for (const t of (txns || []).slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "txn-row";
    const income = t.amount < 0;
    const acct = accountLabel(t.account_id);
    const name = displayTxnName(t);
    const sub = [t.category, acct, shortDate(t.date)].filter(Boolean).map(escapeHtml).join(" · ");
    row.innerHTML = `
      <span class="txn-icon ${iconTone(t.category, income)}">${categoryIcon(t.category, income)}</span>
      <div class="txn-left">
        <span class="txn-name">${escapeHtml(name)}</span>
        <span class="txn-cat">${sub}</span>
      </div>
      <span class="txn-amt ${income ? "pos" : ""}">${income ? "+" : "−"}${fmt(Math.abs(t.amount))}</span>`;
    el.appendChild(row);
  }
  el.scrollTop = 0;
}

function displayTxnName(t) {
  if (t.category === "Paycheck") return "Paycheck";
  return String(t.name || "Transaction")
    .replace(/\s+/g, " ")
    .replace(/^TST\*\s*/i, "")
    .trim();
}

function iconTone(category, income) {
  if (income) return "txn-icon-income";
  const g = groupOf(category);
  return "txn-icon-" + g.toLowerCase().replace(/[^a-z]+/g, "");
}

function categoryIcon(category, income) {
  const g = income ? "Income" : groupOf(category);
  const attrs = `viewBox="0 0 24 24" aria-hidden="true"`;
  const common = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  const icons = {
    Income: `<svg ${attrs}><path ${common} d="M12 3v18"/><path ${common} d="m7 8 5-5 5 5"/><path ${common} d="M5 21h14"/></svg>`,
    Food: `<svg ${attrs}><path ${common} d="M7 2v20"/><path ${common} d="M4 2v6a3 3 0 0 0 6 0V2"/><path ${common} d="M17 2v20"/><path ${common} d="M14 2h6v8a3 3 0 0 1-3 3"/></svg>`,
    Transport: `<svg ${attrs}><path ${common} d="M6 17h12l1-5-2-5H7l-2 5 1 5Z"/><path ${common} d="M8 17v2"/><path ${common} d="M16 17v2"/><path ${common} d="M7 12h10"/></svg>`,
    Shopping: `<svg ${attrs}><path ${common} d="M6 8h12l-1 13H7L6 8Z"/><path ${common} d="M9 8a3 3 0 0 1 6 0"/></svg>`,
    Housing: `<svg ${attrs}><path ${common} d="m3 11 9-8 9 8"/><path ${common} d="M5 10v11h14V10"/><path ${common} d="M10 21v-6h4v6"/></svg>`,
    Health: `<svg ${attrs}><path ${common} d="M12 21s-7-4.4-9-9a5 5 0 0 1 8-5 5 5 0 0 1 8 5c-2 4.6-9 9-9 9Z"/></svg>`,
    Fun: `<svg ${attrs}><path ${common} d="M7 8h10"/><path ${common} d="M7 12h4"/><path ${common} d="M15 12h2"/><path ${common} d="M8 16h8"/><rect ${common} x="3" y="5" width="18" height="14" rx="3"/></svg>`,
    Fees: `<svg ${attrs}><circle ${common} cx="12" cy="12" r="9"/><path ${common} d="M12 7v6"/><path ${common} d="M12 17h.01"/></svg>`,
    Other: `<svg ${attrs}><circle ${common} cx="12" cy="12" r="8"/><path ${common} d="M12 8h.01"/><path ${common} d="M11 12h1v4h1"/></svg>`,
  };
  return icons[g] || icons.Other;
}

// Maps each detailed category to a high-level group for the top-level donut.
const CATEGORY_GROUPS = {
  Groceries: "Food", Restaurants: "Food", "Coffee & Cafes": "Food", "Food Delivery": "Food", "Food And Drink": "Food",
  Rideshare: "Transport", Transit: "Transport", Gas: "Transport", Transportation: "Transport",
  Shopping: "Shopping", "General Merchandise": "Shopping", Electronics: "Shopping", "Home & Furniture": "Shopping",
  Rent: "Housing", Utilities: "Housing", "Rent And Utilities": "Housing",
  Fitness: "Health", "Personal Care": "Health", Medical: "Health",
  Entertainment: "Fun", Subscriptions: "Fun",
  Fees: "Fees", "Bank Fees": "Fees",
};
const groupOf = (cat) => CATEGORY_GROUPS[cat] || "Other";

function buildGroups(categories) {
  const map = {};
  for (const c of categories) {
    const g = groupOf(c.name);
    map[g] = map[g] || { name: g, amount: 0, children: [] };
    map[g].amount += c.amount;
    map[g].children.push(c);
  }
  return Object.values(map)
    .map((g) => ({ name: g.name, amount: g.amount, children: g.children.sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.amount - a.amount);
}

// Two-level donut: high-level groups, click a slice to drill into its categories.
function renderDonut() {
  const ctx = $("cat-chart");
  if (typeof Chart === "undefined") {
    renderChartFallback(ctx, "Spending chart unavailable");
    return;
  }
  if (catChart) catChart.destroy();

  const groups = buildGroups(currentCategories());
  const drilledGroup = donutGroup ? groups.find((g) => g.name === donutGroup) : null;
  const drilledCat =
    drilledGroup && donutCategory ? drilledGroup.children.find((c) => c.name === donutCategory) : null;
  // three levels: groups → a group's categories → a single category (with its purchases listed beside it)
  const items = drilledCat ? [drilledCat] : drilledGroup ? drilledGroup.children : groups;
  const total = items.reduce((s, i) => s + i.amount, 0);
  const rangeLabel = spendRange === "week" ? "7d" : spendRange === "halfyear" ? "6mo" : "30d";
  const headerName = drilledCat ? drilledCat.name : drilledGroup ? drilledGroup.name : null;
  donutItems = items;
  donutTotal = total;
  donutDrilled = !!drilledGroup;

  // breadcrumb / back control — one step up per click
  const crumb = $("donut-crumb");
  crumb.innerHTML = "";
  if (drilledGroup) {
    crumb.hidden = false;
    const back = document.createElement("button");
    back.className = "crumb-back";
    if (drilledCat) {
      back.textContent = "← " + drilledGroup.name;
      back.addEventListener("click", () => { donutCategory = null; renderDonut(); });
    } else {
      back.textContent = "← All categories";
      back.addEventListener("click", () => { donutGroup = null; renderDonut(); });
    }
    const here = document.createElement("span");
    here.className = "crumb-here";
    here.textContent = headerName;
    crumb.append(back, here);
  } else {
    crumb.hidden = true;
  }

  // side list of individual purchases when a leaf category is open
  renderDonutTxns(drilledCat);

  const centerText = {
    id: "centerText",
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const x = (chartArea.left + chartArea.right) / 2;
      const y = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#0f172a";
      ctx.font = "700 26px Lato, sans-serif";
      ctx.fillText(fmt(total), x, y - 7);
      ctx.fillStyle = "#64748b";
      ctx.font = "400 11px Lato, sans-serif";
      ctx.fillText(headerName ? headerName + " · " + rangeLabel : "spent · last " + rangeLabel, x, y + 15);
      ctx.restore();
    },
  };

  catChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: items.map((i) => i.name),
      datasets: [
        {
          data: items.map((i) => i.amount),
          backgroundColor: CHART_COLORS,
          borderColor: "#f6f6f3",
          borderWidth: 2,
          hoverOffset: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "64%",
      // drill in one level per click: group → category → (category stays, list shows beside it)
      onClick: (e, els) => {
        if (drilledCat || !els.length) return;
        if (drilledGroup) donutCategory = items[els[0].index].name;
        else donutGroup = items[els[0].index].name;
        renderDonut();
      },
      onHover: (e, els) => {
        if (e.native) e.native.target.style.cursor = !drilledCat && els.length ? "pointer" : "default";
      },
      plugins: {
        legend: { position: "right", labels: { boxWidth: 12, padding: 9, font: { family: "Lato" } } },
        tooltip: { enabled: false, external: externalTooltip },
      },
    },
    plugins: [centerText],
  });
}

// Scrollable list of the individual purchases in the opened leaf category,
// shown to the right of the (now single-segment) donut, inside the same card.
function renderDonutTxns(cat) {
  const wrap = $("donut-wrap");
  const panel = $("donut-txns");
  if (!cat) {
    wrap.classList.remove("has-list");
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  wrap.classList.add("has-list");
  panel.hidden = false;

  const txns = cat.txns || [];
  const count = txns.length;
  const rows = txns
    .map((t) => {
      const name = displayTxnName(t);
      return `<div class="txn-row">
        <span class="txn-icon ${iconTone(cat.name, false)}">${categoryIcon(cat.name, false)}</span>
        <div class="txn-left">
          <span class="txn-name">${escapeHtml(name)}</span>
          <span class="txn-cat">${escapeHtml(shortDate(t.date))}</span>
        </div>
        <span class="txn-amt">−${fmt(Math.abs(t.amount))}</span>
      </div>`;
    })
    .join("");

  panel.innerHTML =
    `<div class="donut-txns-head">
       <span class="dt-title">${escapeHtml(cat.name)}</span>
       <span class="dt-meta">${count} ${count === 1 ? "purchase" : "purchases"} · ${fmt(cat.amount)}</span>
     </div>` +
    `<div class="donut-txns-list">${rows || '<div class="dt-empty">No purchases in this range.</div>'}</div>`;
  const list = panel.querySelector(".donut-txns-list");
  if (list) list.scrollTop = 0;
}

// shared glassy HTML tooltip element + positioning, used by both charts
function ensureChartTooltip() {
  let el = document.getElementById("chart-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chart-tooltip";
    document.body.appendChild(el);
  }
  return el;
}
function positionTooltip(el, chart, tooltip) {
  const rect = chart.canvas.getBoundingClientRect();
  el.style.opacity = 1;
  let left = rect.left + window.scrollX + tooltip.caretX + 16;
  const top = rect.top + window.scrollY + tooltip.caretY - el.offsetHeight / 2;
  if (left + el.offsetWidth > window.scrollX + document.documentElement.clientWidth - 8) {
    left = rect.left + window.scrollX + tooltip.caretX - el.offsetWidth - 16;
  }
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}

// Clean, glassy HTML tooltip for the donut (replaces Chart.js's bulky default).
function externalTooltip(context) {
  const { chart, tooltip } = context;
  const el = ensureChartTooltip();

  if (tooltip.opacity === 0) {
    el.style.opacity = 0;
    return;
  }

  const dp = tooltip.dataPoints && tooltip.dataPoints[0];
  if (dp) {
    const item = donutItems[dp.dataIndex] || {};
    const color = dp.element.options.backgroundColor;
    const pct = donutTotal ? Math.round((dp.raw / donutTotal) * 100) : 0;

    let body = "";
    if (donutDrilled) {
      const top = item.top || [];
      if (top.length) {
        body =
          `<div class="tt-sub">Most frequent</div>` +
          top
            .map(
              (t) =>
                `<div class="tt-row"><span>${escapeHtml(t.name)}</span><span class="tt-dim">${t.count}× · ${fmt(t.amount)}</span></div>`
            )
            .join("");
      }
    } else {
      const kids = (item.children || []).slice(0, 5);
      body =
        `<div class="tt-sub">Includes</div>` +
        kids
          .map(
            (k) => `<div class="tt-row"><span>${escapeHtml(k.name)}</span><span class="tt-dim">${fmt(k.amount)}</span></div>`
          )
          .join("") +
        `<div class="tt-hint">Click to drill in →</div>`;
    }

    el.innerHTML =
      `<div class="tt-head"><span class="tt-dot" style="background:${color}"></span><span class="tt-name">${escapeHtml(dp.label)}</span></div>` +
      `<div class="tt-amt">${fmt(dp.raw)} <span class="tt-pct">${pct}%</span></div>` +
      body;
  }

  positionTooltip(el, chart, tooltip);
}

// Glassy tooltip for the income-vs-spending bars: month + both bars + net.
function externalTrendTooltip(context) {
  const { chart, tooltip } = context;
  const el = ensureChartTooltip();
  if (tooltip.opacity === 0) {
    el.style.opacity = 0;
    return;
  }
  const idx = tooltip.dataPoints && tooltip.dataPoints[0] ? tooltip.dataPoints[0].dataIndex : 0;
  const income = chart.data.datasets[0].data[idx] || 0;
  const spend = chart.data.datasets[1].data[idx] || 0;
  const net = income - spend;
  const month = tooltip.title && tooltip.title[0] ? tooltip.title[0] : "";

  el.innerHTML =
    `<div class="tt-head"><span class="tt-name">${escapeHtml(month)}</span></div>` +
    `<div class="tt-row"><span><span class="tt-dot" style="background:#16a34a"></span>Income</span><span class="tt-dim">${fmt(income)}</span></div>` +
    `<div class="tt-row"><span><span class="tt-dot" style="background:#0f172a"></span>Spending</span><span class="tt-dim">${fmt(spend)}</span></div>` +
    `<div class="tt-net"><span>Net</span><b class="${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : "−"}${fmt(Math.abs(net))}</b></div>`;

  positionTooltip(el, chart, tooltip);
}

function renderTrendChart(trend) {
  const ctx = $("trend-chart");
  if (typeof Chart === "undefined") {
    renderChartFallback(ctx, "Trend chart unavailable");
    return;
  }
  if (trendChart) trendChart.destroy();
  const labels = trend.map((t) => monthLabel(t.month));
  trendChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: trend.map((t) => t.income), backgroundColor: "#16a34a", borderRadius: 5 },
        { label: "Spending", data: trend.map((t) => t.spend), backgroundColor: "#0f172a", borderRadius: 5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { family: "Lato" } } },
        tooltip: { enabled: false, external: externalTrendTooltip },
      },
      scales: {
        y: { ticks: { callback: (v) => "$" + (v / 1000).toFixed(0) + "k" }, grid: { color: "rgba(15,23,42,0.06)" } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderChartFallback(canvas, message) {
  const box = canvas && canvas.parentElement;
  if (!box) return;
  box.innerHTML = `<div class="chart-fallback">${escapeHtml(message)}</div>`;
}

async function connectBank() {
  try {
    const res = await fetch("/api/plaid/create_link_token", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || "Couldn't start bank linking.");
    const { link_token } = body;
    const handler = Plaid.create({
      token: link_token,
      onSuccess: async (public_token) => {
        await fetch("/api/plaid/exchange_public_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token }),
        });
        window.location.reload();
      },
    });
    handler.open();
  } catch (e) {
    alert(e.message || "Couldn't start bank linking.");
  }
}

function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init();
