// Static ("manual snapshot") accounts — for banks we can't link live (e.g.
// a bank Plaid can't reach). Config lives in data/static-accounts.json and
// can point at a CSV export whose transactions get parsed in.
//
// Each account is flagged { static: true, asOf: <date> } so the dashboard can
// show it's a frozen snapshot, not live data.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "static-accounts.json");

// Splits one CSV line, respecting quoted fields and "" escapes.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toISO(mdy) {
  const m = String(mdy).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return String(mdy);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Bank CSV export format: "Date","No.","Description","Debit","Credit"
// Plaid convention: amount POSITIVE = money out (debit), NEGATIVE = money in.
function parseBankCsv(csvPath, accountId) {
  let raw;
  try { raw = fs.readFileSync(csvPath, "utf8"); } catch { return []; }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const txns = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    const [dateStr, , desc, debit, credit] = cols;
    const amount = (parseFloat(debit) || 0) - (parseFloat(credit) || 0);
    txns.push({
      transaction_id: `static_${accountId}_${i}`,
      account_id: accountId,
      date: toISO(dateStr),
      name: desc || "Transaction",
      merchant_name: null,
      amount: Math.round(amount * 100) / 100,
    });
  }
  return txns;
}

function loadStatic() {
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return { accounts: [], transactions: [] }; }
  if (!Array.isArray(config)) return { accounts: [], transactions: [] };

  const accounts = [];
  let transactions = [];
  for (const a of config) {
    accounts.push({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name || null,
      mask: a.mask || null,
      type: a.type || "depository",
      subtype: a.subtype || "checking",
      institution: a.institution || "Bank",
      balances: { current: a.balance == null ? 0 : a.balance },
      static: true,
      asOf: a.asOf || null,
    });
    if (a.csvPath) transactions = transactions.concat(parseBankCsv(a.csvPath, a.account_id));
  }
  return { accounts, transactions };
}

module.exports = { loadStatic, parseBankCsv };
