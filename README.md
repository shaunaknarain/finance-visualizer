# Finance Visualizer

A Mint-style personal finance dashboard. It pulls checking, credit card and
brokerage accounts into one place through Plaid, then breaks down net worth,
spending by category and merchant, paychecks and investment holdings.

**Live demo (fake data):** https://shaunaknarain.com/finance-demo/

This copy is the demo. With no Plaid keys it serves made-up accounts from
`lib/demo.js`, so anyone can run it. My real instance runs privately on my own
hardware and never leaves it.

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

## Run it

    npm install
    npm start              # http://localhost:4000, demo data

To point it at real banks, copy `.env.example` to `.env` and add Plaid keys.

## Stack

Node + Express, Plaid API, vanilla JS and Chart.js on the front end.
