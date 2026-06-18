// Turns raw Plaid accounts + transactions into the numbers the dashboard shows:
// net worth, assets/liabilities, spend-by-category, monthly trend, recent txns.

// User-defined paycheck rule: deposits whose description contains these words
// are always treated as income, never spending, no matter how Plaid labels them.
const PAYCHECK_RE = /payroll/i;
function isPaycheck(t) {
  return PAYCHECK_RE.test(t.merchant_name || "") || PAYCHECK_RE.test(t.name || "");
}

// Transfers and credit-card/loan payments aren't "spending" — they move money
// between your own accounts (or pay off a card whose purchases already counted).
// Excluding them keeps the spending breakdown from double-counting.
// LOAN_DISBURSEMENTS is the *other* leg of a credit-card payment — the
// "Payment Thank You" credit that lands on the card. Without it here, that
// negative-amount leg gets counted as income (a phantom +$ deposit).
const NON_SPEND = new Set([
  "LOAN_PAYMENTS", "LOAN_DISBURSEMENTS", "TRANSFER_IN", "TRANSFER_OUT", "CREDIT_CARD_PAYMENT",
]);
function primaryCat(t) {
  return t.personal_finance_category && t.personal_finance_category.primary;
}
function isTransferOrPayment(t) {
  return NON_SPEND.has(primaryCat(t));
}
// Both legs of paying off a card: the debit out of checking and the credit
// onto the card. Filtered from the transaction feed (internal money movement).
function isCardPayment(t) {
  const p = primaryCat(t);
  return p === "LOAN_PAYMENTS" || p === "CREDIT_CARD_PAYMENT" || p === "LOAN_DISBURSEMENTS";
}

// Plaid convention: transaction.amount is POSITIVE when money leaves the
// account (spending) and NEGATIVE when money comes in (income/refund).
function isSpending(t) {
  return t.amount > 0 && !isPaycheck(t) && !isTransferOrPayment(t);
}

// Merchant-keyword rules, checked in order BEFORE Plaid's broad categories.
// This is what gives the real granularity (groceries vs restaurants vs coffee,
// rideshare vs transit, subscriptions, etc.). Order matters — more specific first.
const CATEGORY_RULES = [
  { cat: "Groceries", re: /trader joe|whole foods|wholefds|safeway|ralphs|kroger|sprouts|aldi|costco|grocery/i },
  { cat: "Food Delivery", re: /doordash|uber ?eats|grubhub|postmates|caviar|seamless/i },
  { cat: "Coffee & Cafes", re: /coffee|caf[eé]\b|starbucks|peet'?s|dunkin|boba|matcha/i },
  { cat: "Restaurants", re: /restaurant|taqueria|tacos?|chipotle|pizza|grill|kitchen|bistro|thai|sushi|ramen|burger|mcdonald|chick.?fil|sweetgreen|cava|deli|noodle|cantina|eatery|dumpling/i },
  { cat: "Rideshare", re: /uber|lyft|waymo|\btaxi\b/i },
  { cat: "Transit", re: /metro|transit fare|subway fare/i },
  { cat: "Gas", re: /shell|chevron|exxon|\barco\b|valero|mobil|76 station/i },
  { cat: "Subscriptions", re: /netflix|spotify|hulu|disney ?\+|youtube ?premium|\bhbo\b|apple\.com\/bill|prime video|patreon|notion|openai|chatgpt|icloud|adobe/i },
  { cat: "Utilities", re: /comcast|xfinity|at&?t|verizon|t-?mobile|water dept|\belectric\b|\binternet\b/i },
  { cat: "Rent", re: /\brent\b|apartment|leasing|property mgmt|property manage|\brealty\b/i },
  { cat: "Home & Furniture", re: /ikea|wayfair|home depot|lowe'?s|hardware|crate.?barrel|west elm|\bcb2\b|container store|bed bath/i },
  { cat: "Electronics", re: /best buy|apple store|micro ?center|newegg|b&h photo/i },
  { cat: "Shopping", re: /amazon|\bamzn\b|target|walmart|etsy|\bebay\b|nordstrom|macy|uniqlo|\bnike\b|\bzara\b/i },
  { cat: "Fitness", re: /equinox|fitness|\bgym\b|peloton|classpass|yoga|crossfit/i },
  { cat: "Fees", re: /annual membership fee|atm fee|overdraft|foreign transaction|service fee|late fee|interest charge/i },
];

function categoryOf(t) {
  if (isPaycheck(t)) return "Paycheck";
  // Card payments must be caught BEFORE the merchant keyword rules, or a
  // description like "Payment Thank You-Mobile" matches the gas rule ("mobil").
  if (isCardPayment(t)) return "Credit Card Payment";
  const hay = `${t.merchant_name || ""} ${t.name || ""}`;
  for (const r of CATEGORY_RULES) if (r.re.test(hay)) return r.cat;
  // fall back to Plaid's category
  const p = primaryCat(t);
  if (p) return prettifyCategory(p);
  if (Array.isArray(t.category) && t.category.length) return t.category[0];
  return "Other";
}

function prettifyCategory(raw) {
  return String(raw)
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function monthKey(dateStr) {
  return String(dateStr).slice(0, 7); // YYYY-MM
}

// accounts: flattened list across all linked items, each tagged with institution.
// transactions: flattened list across all items.
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Spend-by-category for everything on/after `sinceStr`, with each category's
// most-frequent merchants attached for the hover tooltip.
function computeCategories(transactions, sinceStr) {
  const spendByCategory = {};
  const merchantByCat = {};
  const txnsByCat = {};
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    if (t.date < sinceStr) continue;
    const cat = categoryOf(t);
    spendByCategory[cat] = (spendByCategory[cat] || 0) + t.amount;
    const m = t.merchant_name || t.name;
    merchantByCat[cat] = merchantByCat[cat] || {};
    const e = (merchantByCat[cat][m] = merchantByCat[cat][m] || { amount: 0, count: 0 });
    e.amount += t.amount;
    e.count += 1;
    (txnsByCat[cat] = txnsByCat[cat] || []).push({ date: t.date, name: m, amount: round2(t.amount) });
  }
  return Object.entries(spendByCategory)
    .map(([name, amount]) => ({
      name,
      amount: round2(amount),
      top: Object.entries(merchantByCat[name] || {})
        .map(([m, v]) => ({ name: m, amount: round2(v.amount), count: v.count }))
        .sort((a, b) => b.count - a.count || b.amount - a.amount)
        .slice(0, 4),
      // every individual purchase in this category, newest first (for the drill-in list)
      txns: (txnsByCat[name] || []).sort((a, b) => (a.date < b.date ? 1 : -1)),
    }))
    .sort((a, b) => b.amount - a.amount);
}

// Paycheck breakdown from PAYROLL deposits: typical check, monthly,
// annualized. Uses complete months for the averages so a partial current
// month doesn't drag the numbers down.
function paycheckBreakdown(transactions) {
  const pays = transactions
    .filter(isPaycheck)
    .map((t) => ({ date: t.date, amount: Math.abs(t.amount) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!pays.length) return null;

  const byMonth = {};
  for (const p of pays) byMonth[p.date.slice(0, 7)] = (byMonth[p.date.slice(0, 7)] || 0) + p.amount;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const allMonths = Object.keys(byMonth);
  const useMonths = allMonths.filter((m) => m !== currentMonth);
  const months = useMonths.length ? useMonths : allMonths;

  const avgMonthly = months.reduce((s, m) => s + byMonth[m], 0) / months.length;
  const checksInUse = pays.filter((p) => months.includes(p.date.slice(0, 7)));
  const avgCheck = checksInUse.reduce((s, p) => s + p.amount, 0) / (checksInUse.length || 1);

  return {
    lastAmount: round2(pays[0].amount),
    lastDate: pays[0].date,
    avgCheck: round2(avgCheck),
    perMonth: round2(avgMonthly),
    perYear: round2(avgMonthly * 12),
    checksPerMonth: Math.round((checksInUse.length / months.length) * 10) / 10,
    count: pays.length,
  };
}

const VENMO_RE = /\bvenmo\b/i;
function isVenmo(t) {
  return VENMO_RE.test(t.merchant_name || "") || VENMO_RE.test(t.name || "");
}

function venmoDisplayName(t) {
  const raw = String(t.merchant_name || t.name || "Venmo").trim();
  const cleaned = raw
    .replace(/\bvenmo\b/gi, "")
    .replace(/\bpayment\b|\bcashout\b|\btransfer\b|\bpurchase\b/gi, "")
    .replace(/[*#:/\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Venmo";
}

function venmoBreakdown(transactions, accounts) {
  const walletAccount = (accounts || []).find((a) =>
    VENMO_RE.test(`${a.nickname || ""} ${a.name || ""} ${a.official_name || ""} ${a.institution || ""}`)
  );
  const rows = transactions
    .filter(isVenmo)
    .map((t) => {
      const sent = t.amount > 0;
      return {
        id: t.transaction_id || `${t.date}_${t.name}_${t.amount}`,
        date: t.date,
        name: venmoDisplayName(t),
        originalName: t.merchant_name || t.name || "Venmo",
        amount: round2(Math.abs(t.amount || 0)),
        direction: sent ? "sent" : "received",
        category: categoryOf(t),
        account_id: t.account_id || null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const since30 = daysAgoStr(30);
  const recent30 = rows.filter((r) => r.date >= since30);
  const sent30 = round2(recent30.filter((r) => r.direction === "sent").reduce((s, r) => s + r.amount, 0));
  const received30 = round2(recent30.filter((r) => r.direction === "received").reduce((s, r) => s + r.amount, 0));

  const byPerson = {};
  for (const r of recent30) {
    const p = (byPerson[r.name] = byPerson[r.name] || { name: r.name, sent: 0, received: 0, count: 0, lastDate: r.date });
    p[r.direction] += r.amount;
    p.count += 1;
    if (r.date > p.lastDate) p.lastDate = r.date;
  }

  return {
    wallet: walletAccount
      ? {
          name: walletAccount.nickname || walletAccount.name || "Venmo",
          institution: walletAccount.institution || "Venmo",
          mask: walletAccount.mask || null,
          balance: round2(walletAccount.balance || 0),
        }
      : null,
    sent30,
    received30,
    net30: round2(received30 - sent30),
    count30: recent30.length,
    people: Object.values(byPerson)
      .map((p) => ({ ...p, sent: round2(p.sent), received: round2(p.received), net: round2(p.received - p.sent) }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.count - a.count)
      .slice(0, 6),
    recent: rows.slice(0, 18),
    orders: rows.filter((r) => r.direction === "sent").slice(0, 4),
  };
}

function serviceStatuses(accounts, transactions) {
  const byInstitution = {};
  for (const a of accounts) {
    const key = a.institution || "Bank";
    const row = (byInstitution[key] = byInstitution[key] || {
      name: key,
      status: a.static ? "Static" : "Live",
      static: !!a.static,
      lastUpdate: a.asOf || null,
      accountIds: new Set(),
    });
    row.static = row.static && !!a.static;
    row.status = row.static ? "Static" : "Live";
    if (a.asOf && (!row.lastUpdate || a.asOf > row.lastUpdate)) row.lastUpdate = a.asOf;
    if (a.account_id) row.accountIds.add(a.account_id);
  }

  for (const t of transactions) {
    for (const row of Object.values(byInstitution)) {
      if (!row.accountIds.has(t.account_id)) continue;
      if (t.date && (!row.lastUpdate || t.date > row.lastUpdate)) row.lastUpdate = t.date;
      break;
    }
  }

  return Object.values(byInstitution)
    .map((row) => ({
      name: row.name,
      status: row.status,
      lastUpdate: row.lastUpdate,
    }))
    .sort((a, b) => serviceOrder(a.name) - serviceOrder(b.name) || a.name.localeCompare(b.name));
}

function serviceOrder(name) {
  const n = String(name).toLowerCase();
  if (/invest|brokerage/.test(n)) return 3;
  if (n.includes("venmo")) return 4;
  return 9;
}

// Merchants that are subscriptions by definition, even with a single charge.
const SUBSCRIPTION_RE =
  /netflix|spotify|hulu|disney ?\+|youtube ?premium|\bhbo\b|\bmax\b|paramount|peacock|apple\.?(com\/bill|care|music|tv)|icloud|prime video|amazon prime|patreon|notion|openai|chatgpt|anthropic|claude|adobe|dropbox|github|figma|canva|squarespace|substack|audible|nyt|new york times|wsj|equinox|classpass|peloton/i;
// Recurring utility/telecom bills (mirrors the Utilities keyword rule) — these
// are real "set and forget" services even from a single observed charge.
const BILLS_RE = /comcast|xfinity|verizon|t-?mobile|at&t|\batt\b|water dept|\belectric\b|\binternet\b/i;
// Categories our own categorizer assigns to inherently recurring services.
const RECURRING_CATS = new Set(["Subscriptions", "Fitness"]);
// Categories of clearly variable spending — never inferred as subscriptions,
// even when a merchant happens to repeat at a steady amount and cadence.
const NON_RECURRING_CATS = new Set([
  "Groceries", "Restaurants", "Coffee & Cafes", "Food Delivery", "Food And Drink",
  "Rideshare", "Transit", "Gas", "Shopping", "General Merchandise", "Electronics",
  "Home & Furniture", "Rent", "Fees",
]);

// Recurring subscriptions & bills — the "set it and forget it" charges worth a
// periodic glance. A merchant qualifies if it's a known subscription, sits in a
// recurring-service category, or simply repeats at a steady amount and cadence.
function recurringServices(transactions) {
  const byMerchant = {};
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    const name = String(t.merchant_name || t.name || "").trim();
    if (!name) continue;
    const g = (byMerchant[name] = byMerchant[name] || { name, charges: [], cat: categoryOf(t) });
    g.charges.push({ date: t.date, amount: t.amount });
  }

  const items = [];
  for (const g of Object.values(byMerchant)) {
    g.charges.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    const amounts = g.charges.map((c) => c.amount);
    const n = amounts.length;

    const mean = amounts.reduce((s, a) => s + a, 0) / n;
    const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / n;
    const cv = mean ? Math.sqrt(variance) / mean : 1; // coefficient of variation

    // average gap between charges, in days
    let avgGap = null;
    if (n >= 2) {
      const days = g.charges.map((c) => Date.parse(c.date)).sort((a, b) => a - b);
      let total = 0;
      for (let i = 1; i < days.length; i++) total += (days[i] - days[i - 1]) / 86400000;
      avgGap = total / (days.length - 1);
    }

    const keyworded = SUBSCRIPTION_RE.test(g.name) || BILLS_RE.test(g.name);
    const catRecurring = RECURRING_CATS.has(g.cat);
    // generic: repeats 3+ times at a near-constant amount on a monthly→yearly
    // cadence — but only in categories that plausibly hold a subscription.
    const looksRecurring =
      n >= 3 && cv < 0.1 && avgGap != null && avgGap >= 20 && avgGap <= 400 && !NON_RECURRING_CATS.has(g.cat);
    if (!(keyworded || catRecurring || looksRecurring)) continue;

    const lastAmount = round2(g.charges[0].amount);
    let cadence = "monthly";
    let monthly = lastAmount;
    if (avgGap != null) {
      if (avgGap <= 10) { cadence = "weekly"; monthly = lastAmount * (30.4 / 7); }
      else if (avgGap <= 20) { cadence = "biweekly"; monthly = lastAmount * (30.4 / 14); }
      else if (avgGap <= 45) { cadence = "monthly"; monthly = lastAmount; }
      else if (avgGap <= 75) { cadence = "every ~2 mo"; monthly = lastAmount / 2; }
      else if (avgGap <= 135) { cadence = "quarterly"; monthly = lastAmount / 3; }
      else { cadence = "yearly"; monthly = lastAmount / 12; }
    }

    items.push({
      name: g.name,
      category: g.cat,
      lastAmount,
      lastDate: g.charges[0].date,
      count: n,
      cadence,
      monthly: round2(monthly),
    });
  }

  items.sort((a, b) => b.monthly - a.monthly);
  const monthlyTotal = round2(items.reduce((s, r) => s + r.monthly, 0));
  return { items, monthlyTotal, yearlyTotal: round2(monthlyTotal * 12) };
}

// Housing-related spending a roommate would typically split: rent, utilities,
// and furniture/home goods for shared space. Used by the Details-tab splitter.
const HOUSING_SPLIT_CATS = new Set([
  "Rent", "Utilities", "Rent And Utilities", "Home & Furniture",
]);
function housingPurchases(transactions, sinceStr) {
  return transactions
    .filter((t) => isSpending(t) && t.date >= sinceStr && HOUSING_SPLIT_CATS.has(categoryOf(t)))
    .map((t) => ({
      id: t.transaction_id || `${t.date}_${t.merchant_name || t.name}_${t.amount}`,
      date: t.date,
      name: t.merchant_name || t.name,
      amount: round2(t.amount),
      category: categoryOf(t),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function buildOverview(accounts, transactions) {
  let assets = 0;
  let liabilities = 0;
  let cash = 0; // depository (checking/savings)
  let investments = 0; // brokerage/retirement

  // Most recent *purchase* (money out) per account — used to flag credit cards
  // that haven't been used in a while so they don't get auto-closed.
  const lastUsedByAccount = {};
  for (const t of transactions) {
    if (!t.account_id || t.amount <= 0) continue; // purchases only
    if (!lastUsedByAccount[t.account_id] || t.date > lastUsedByAccount[t.account_id]) {
      lastUsedByAccount[t.account_id] = t.date;
    }
  }

  const normalizedAccounts = accounts.map((a) => {
    const bal = (a.balances && a.balances.current) || 0;
    const isLiability = a.type === "credit" || a.type === "loan";
    if (isLiability) {
      liabilities += bal;
    } else {
      assets += bal;
      if (a.type === "investment") investments += bal;
      else cash += bal;
    }
    return {
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name || null,
      mask: a.mask || null,
      type: a.type,
      subtype: a.subtype,
      institution: a.institution || "Bank",
      balance: bal,
      isLiability,
      isCreditCard: a.type === "credit",
      lastUsed: lastUsedByAccount[a.account_id] || null,
      static: a.static || false,
      asOf: a.asOf || null,
    };
  });

  // ----- spend by category, for week / month / 6-month windows -----
  const categoriesWeek = computeCategories(transactions, daysAgoStr(7));
  const categories = computeCategories(transactions, daysAgoStr(30)); // default view
  const categoriesHalfYear = computeCategories(transactions, daysAgoStr(180));

  // ----- monthly spend trend (last 6 months) -----
  const months = lastNMonths(6);
  const spendByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  const incomeByMonth = Object.fromEntries(months.map((m) => [m, 0]));
  for (const t of transactions) {
    const m = monthKey(t.date);
    if (!(m in spendByMonth)) continue;
    if (isPaycheck(t)) incomeByMonth[m] += Math.abs(t.amount);
    else if (isTransferOrPayment(t)) continue; // skip transfers / card payments
    else if (t.amount > 0) spendByMonth[m] += t.amount;
    else incomeByMonth[m] += -t.amount;
  }
  const trend = months.map((m) => ({
    month: m,
    spend: round2(spendByMonth[m]),
    income: round2(incomeByMonth[m]),
  }));

  // ----- recent transactions -----
  const recent = [...transactions]
    .filter((t) => !isCardPayment(t)) // hide internal card-payoff legs from the feed
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 25)
    .map((t) => ({
      date: t.date,
      name: t.merchant_name || t.name,
      amount: round2(t.amount),
      category: categoryOf(t),
      account_id: t.account_id || null,
    }));

  const monthSpendTotal = trend.length ? trend[trend.length - 1].spend : 0;

  return {
    netWorth: round2(assets - liabilities),
    assets: round2(assets),
    cash: round2(cash),
    investments: round2(investments),
    liabilities: round2(liabilities),
    monthSpendTotal,
    accounts: normalizedAccounts,
    categories,
    categoriesByRange: { week: categoriesWeek, month: categories, halfyear: categoriesHalfYear },
    paycheck: paycheckBreakdown(transactions),
    venmo: venmoBreakdown(transactions, normalizedAccounts),
    services: serviceStatuses(normalizedAccounts, transactions),
    subscriptions: recurringServices(transactions),
    housing: housingPurchases(transactions, daysAgoStr(60)),
    trend,
    recent,
  };
}

function lastNMonths(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Flattens Plaid investmentsHoldingsGet results (across items) into a simple
// position list. `sources` = [{ holdings, securities, institution }].
function normalizeHoldings(sources) {
  const rows = [];
  for (const src of sources || []) {
    if (!src || !src.holdings) continue;
    const secById = new Map((src.securities || []).map((s) => [s.security_id, s]));
    for (const h of src.holdings) {
      const sec = secById.get(h.security_id) || {};
      rows.push({
        ticker: sec.ticker_symbol || (sec.name ? "" : "—"),
        name: sec.name || sec.ticker_symbol || "Security",
        quantity: round2(h.quantity),
        value: round2(h.institution_value ?? 0),
        institution: src.institution || "Brokerage",
      });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  const total = round2(rows.reduce((s, r) => s + r.value, 0));
  return { rows, total };
}

module.exports = { buildOverview, normalizeHoldings };
