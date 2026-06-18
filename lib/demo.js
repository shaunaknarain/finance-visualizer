// OBVIOUSLY-FAKE demo data — fictional merchants, tiny numbers, "Demo Bank"
// accounts — so it can never be mistaken for real finances. Shaped like Plaid's
// output so buildOverview() treats it identically to real data.

const ACCOUNTS = [
  { account_id: "demo_chk", name: "Demo Checking", official_name: "Demo Bank Everyday Checking", mask: "0000", type: "depository", subtype: "checking", institution: "Demo Bank", balances: { current: 842.17 } },
  { account_id: "demo_sav", name: "Demo Savings", official_name: "Demo Bank Savings", mask: "1111", type: "depository", subtype: "savings", institution: "Demo Bank", balances: { current: 1500.0 } },
  { account_id: "demo_card", name: "Demo Rewards Card", official_name: "Demo Bank Rewards Visa", mask: "2222", type: "credit", subtype: "credit card", institution: "Demo Bank", balances: { current: 215.4 } },
  { account_id: "demo_inv", name: "Demo Brokerage", official_name: "Demo Invest Individual", mask: "3333", type: "investment", subtype: "brokerage", institution: "Demo Invest", balances: { current: 2800.0 } },
];

// Fictional merchants. `cat` becomes the fallback Plaid category; several names
// also hit the keyword rules (coffee/burger/gym/grocery/taxi/transit).
const MERCHANTS = [
  { name: "Bloop Coffee", cat: "Coffee", min: 3.25, max: 6.5, perMonth: 9 },
  { name: "FreshBytes Grocery", cat: "Groceries", min: 14, max: 52, perMonth: 5 },
  { name: "Byte Burgers", cat: "Restaurants", min: 8, max: 17, perMonth: 3 },
  { name: "Noodle Planet", cat: "Restaurants", min: 11, max: 22, perMonth: 2 },
  { name: "Zippy Taxi", cat: "Rideshare", min: 6, max: 19, perMonth: 4 },
  { name: "Metro Transit Pass", cat: "Transit", min: 2.5, max: 2.5, perMonth: 8 },
  { name: "Widget World", cat: "General Merchandise", min: 9, max: 45, perMonth: 2 },
  { name: "Galaxy Gym", cat: "Fitness", min: 25, max: 25, perMonth: 1 },
  { name: "Streamly", cat: "Entertainment", min: 9.99, max: 9.99, perMonth: 1 },
  { name: "Tunes Plus", cat: "Entertainment", min: 5.99, max: 5.99, perMonth: 1 },
  { name: "Sparkle Laundry", cat: "Personal Care", min: 4, max: 8, perMonth: 2 },
  { name: "Demo Sublet", cat: "Rent", min: 700, max: 700, perMonth: 1 },
];

const VENMO_NAMES = ["VENMO Luna Picnic", "VENMO Ari Show Tickets", "VENMO Maya Brunch", "VENMO Jules Groceries"];

const SECURITIES = [
  { security_id: "d1", ticker_symbol: "DEMO", name: "Demo Index Fund" },
  { security_id: "d2", ticker_symbol: "MOCK", name: "Mock Tech ETF" },
  { security_id: "d3", ticker_symbol: "TEST", name: "Test Holdings Inc" },
];
const HOLDINGS = [
  { security_id: "d1", quantity: 12, institution_value: 1500 },
  { security_id: "d2", quantity: 6, institution_value: 820 },
  { security_id: "d3", quantity: 9, institution_value: 480 },
];

let seed = 1337;
function rng() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function between(min, max) {
  return min + (max - min) * rng();
}

function generateTransactions() {
  const txns = [];
  const today = new Date();
  let id = 0;

  for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo--) {
    const base = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
    const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    const maxDay = monthsAgo === 0 ? today.getDate() : daysInMonth;

    for (const m of MERCHANTS) {
      const count = m.perMonth >= 1 ? m.perMonth : rng() < m.perMonth ? 1 : 0;
      for (let i = 0; i < count; i++) {
        const day = Math.max(1, Math.min(maxDay, Math.floor(between(1, maxDay + 1))));
        const date = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        txns.push({
          transaction_id: `demo_t_${id++}`,
          account_id: "demo_card",
          date,
          name: m.name,
          merchant_name: m.name,
          amount: Math.round(between(m.min, m.max) * 100) / 100, // positive = spend
          personal_finance_category: { primary: m.cat.replace(/ /g, "_").toUpperCase() },
        });
      }
    }

    // twice-monthly demo paycheck (negative = income)
    for (const day of [1, 15]) {
      if (day > maxDay) continue;
      const date = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      txns.push({
        transaction_id: `demo_pay_${id++}`,
        account_id: "demo_chk",
        date,
        name: "DEMO PAYROLL",
        merchant_name: "Demo Co",
        amount: -1150.0,
        personal_finance_category: { primary: "INCOME" },
      });
    }

    // a few fictional Venmo reimbursements / splits so the Venmo card has data
    for (let i = 0; i < Math.min(3, maxDay); i++) {
      const day = Math.max(1, Math.min(maxDay, Math.floor(between(2, maxDay + 1))));
      const date = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      txns.push({
        transaction_id: `demo_venmo_${id++}`,
        account_id: "demo_chk",
        date,
        name: VENMO_NAMES[i % VENMO_NAMES.length],
        merchant_name: VENMO_NAMES[i % VENMO_NAMES.length],
        amount: Math.round(between(8, 44) * 100) / 100,
        personal_finance_category: { primary: "TRANSFER_OUT" },
      });
    }

    if (maxDay > 10) {
      const date = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-10`;
      txns.push({
        transaction_id: `demo_venmo_in_${id++}`,
        account_id: "demo_chk",
        date,
        name: "VENMO Theo Dinner Payback",
        merchant_name: "VENMO Theo Dinner Payback",
        amount: -18.5,
        personal_finance_category: { primary: "TRANSFER_IN" },
      });
    }
  }
  return txns;
}

module.exports = {
  accounts: ACCOUNTS,
  transactions: generateTransactions(),
  holdingSources: [{ holdings: HOLDINGS, securities: SECURITIES, institution: "Demo Invest" }],
};
