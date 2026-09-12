---
name: verify-erp
description: Run or write Friendly ERP's verification suites — the 50 server suites against a real Postgres, plus the SPA tests. Use before trusting any change to permissions, RLS, routes or money handling, and whenever a suite fails for reasons that look like infrastructure.
---

# Verifying a change

Fifty server suites run against a real PostgreSQL and a real HTTP server,
because what this codebase gets wrong — RLS policies, permission grants,
transaction boundaries — is exactly what a mocked database cannot be wrong
about.

## Running them

```bash
npm test                                  # 110 SPA tests, no services needed
cd server && npm run verify:<suite>       # one of 50
```

The server suites need three things, and getting any of them wrong produces
failures that look like regressions:

- **`erp_test` on 5433** — not `friendly_crm`. The seeders read
  `DATABASE_ADMIN_URL` from `.env`, which points at the dev database, so name
  `erp_test` explicitly every time.
- **the API on 4055** against that database — `server/README.md` has the exact
  environment block.
- **`AUTH_RATE_LIMIT_MAX=200`** — login is capped at 5/min per address, so a
  batch of suites drains it and everything after the first fails on
  `login failed`. Test runs only; the default of 5 is what makes password
  guessing expensive.

A suite can also fail on Windows *after* passing: `verify:merge` prints
`7 passed, 0 failed` then crashes on exit with a libuv `UV_HANDLE_CLOSING`
assertion. Re-run it alone before treating it as real; CI runs Ubuntu, where it
does not happen.

## Writing one

Three habits, each of which has caught something here that the others missed.

**Positive controls.** A suite of only negative assertions passes on a product
that is broken for everyone — "the maker cannot approve" is satisfied just as
well by a 500 on every request. Pair every refusal with the same action
succeeding for whoever should be able to take it.

**Read-your-writes, as a different session.** A 2xx proves the request was
accepted, not that it persisted, and not that the server did what the *rules*
require rather than what the client asked. Read the row back with another
account. The assertion that mattered most in the RA-bill work was not two 200s;
it was that the stored row named **two different people**.

**Falsify before trusting.** Re-introduce the defect, watch the suite go red on
the right assertion with a message that names the thing, then restore. Twice
here a new test could not fail at all — one matched a pattern anywhere in the
file rather than on the element under test, and stayed green when the fix was
stripped out. A check that cannot fail is worse than none, because it gets
trusted.

Scope standing guards to the population they describe. A check across *every*
tenant in the database will trip on the throwaway fixtures other suites create
mid-run; scope it to workspaces that can actually reach the thing being
guarded. A check that cries wolf gets deleted rather than heeded.

## When the product looks broken and the API is fine

Several defects here lived entirely in the client and were invisible to all
fifty suites, because the server was answering correctly throughout:

- a dashboard reading a store nothing populates, reporting `0` on a workspace
  with 46 units
- an expired session rendering as an empty workspace instead of a login prompt
- tables that *deleted* their columns below `md` rather than scrolling

So when a screen looks wrong, check what the API returns for that same user
before reading any component. If the API is right, the bug is in which source
the component read — and the regression test belongs in `src/**/__smoke__/`,
not in a server suite.
