# Finance Visualizer

Hey! I built this personal finance dashboard as a quick and easy way to get a holistic understanding of your finances via Plaid API.. It pulls checking, credit card and
brokerage accounts into one place through Plaid API, then breaks down net worth,
spending by category and merchant, paychecks and investment holdings.

Note: You need to apply for a plaid api via their developer portal. https://plaid.com/docs/api/

**Check out a demo here::** https://shaunaknarain.com/finance-demo/

## What it does

- Net worth split into cash, investments and liabilities
- Weekly and monthly spending, with a category donut and top merchants
- Custom merchant rules (groceries vs. restaurants vs. coffee) applied before
  Plaid's own labels; card payments excluded from spending
- Paycheck callout built from payroll deposits
- Account nicknames, and a "last used" flag for dormant credit cards
- Survives bank outages: falls back to the last good balances, shows a stale
  banner, and offers a one-click Reconnect when a bank needs a fresh login
- Caches the slow Plaid calls, so repeat loads are instant
