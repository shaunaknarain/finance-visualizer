// Plaid client + thin wrappers around the endpoints we use.
// Reads PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV from the environment.
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

const PLAID_ENV = process.env.PLAID_ENV || "sandbox";

// `configured` is false until you add real keys — the server uses this to
// fall back to demo mode so the dashboard still works with no Plaid account.
const configured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

let client = null;
if (configured) {
  client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[PLAID_ENV],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
          "PLAID-SECRET": process.env.PLAID_SECRET,
        },
      },
    })
  );
}

// Passing an existing item's access token opens Link in "update mode", which
// re-authenticates that bank in place (no new item, no duplicate accounts).
async function createLinkToken(userId, accessToken) {
  if (accessToken) {
    const resp = await client.linkTokenCreate({
      user: { client_user_id: String(userId) },
      client_name: "Personal Finance",
      access_token: accessToken,
      country_codes: ["US"],
      language: "en",
    });
    return resp.data.link_token;
  }
  const resp = await client.linkTokenCreate({
    user: { client_user_id: String(userId) },
    client_name: "Personal Finance",
    // Only `transactions` is required (almost every bank supports it).
    // `investments` is pulled in only at banks that have it (brokerages, 401k/
    // IRA) — listing it as required would hide plain checking-only banks.
    products: ["transactions"],
    optional_products: ["investments"],
    country_codes: ["US"],
    language: "en",
  });
  return resp.data.link_token;
}

async function exchangePublicToken(publicToken) {
  const resp = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { access_token: resp.data.access_token, item_id: resp.data.item_id };
}

// Best-effort friendly name for the linked bank (e.g. "Acme Bank").
async function getInstitutionName(accessToken) {
  try {
    const item = await client.itemGet({ access_token: accessToken });
    const instId = item.data.item.institution_id;
    if (!instId) return null;
    const inst = await client.institutionsGetById({
      institution_id: instId,
      country_codes: ["US"],
    });
    return inst.data.institution.name;
  } catch {
    return null;
  }
}

// `accountsBalanceGet` forces a real-time balance refresh at the bank, which
// is what throws INSTITUTION_NOT_RESPONDING (and friends) when the institution
// is slow or briefly down. Fall back to `accountsGet` — Plaid's last-known
// cached balances — so the dashboard still loads instead of hard-failing.
const TRANSIENT_INSTITUTION_ERRORS = new Set([
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_DOWN",
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
]);

// Errors that only clear once the user logs back in through Link update mode.
const RELINK_ERRORS = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "USER_SETUP_REQUIRED",
  "MFA_NOT_SUPPORTED",
]);

function needsRelink(e) {
  return RELINK_ERRORS.has(e.response?.data?.error_code);
}

async function getAccounts(accessToken) {
  try {
    const resp = await client.accountsBalanceGet({ access_token: accessToken });
    return resp.data.accounts;
  } catch (e) {
    const code = e.response?.data?.error_code;
    if (TRANSIENT_INSTITUTION_ERRORS.has(code)) {
      const resp = await client.accountsGet({ access_token: accessToken });
      return resp.data.accounts;
    }
    throw e;
  }
}

// Stock/fund positions for brokerage & retirement accounts.
// Returns null if this institution/item has no investment accounts, so the
// caller can just skip it without erroring.
async function getHoldings(accessToken) {
  try {
    const resp = await client.investmentsHoldingsGet({ access_token: accessToken });
    return { holdings: resp.data.holdings, securities: resp.data.securities, accounts: resp.data.accounts };
  } catch (e) {
    const code = e.response?.data?.error_code;
    if (code === "PRODUCTS_NOT_SUPPORTED" || code === "NO_INVESTMENT_ACCOUNTS") return null;
    throw e;
  }
}

// Pull all new/changed/removed transactions since the stored cursor.
async function syncTransactions(accessToken, cursor) {
  let added = [];
  let modified = [];
  let removed = [];
  let nextCursor = cursor;
  let hasMore = true;

  while (hasMore) {
    const resp = await client.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor || undefined,
    });
    added = added.concat(resp.data.added);
    modified = modified.concat(resp.data.modified);
    removed = removed.concat(resp.data.removed);
    hasMore = resp.data.has_more;
    nextCursor = resp.data.next_cursor;
  }

  return { added, modified, removed, cursor: nextCursor };
}

module.exports = {
  configured,
  PLAID_ENV,
  createLinkToken,
  exchangePublicToken,
  getInstitutionName,
  getAccounts,
  getHoldings,
  syncTransactions,
  needsRelink,
};
