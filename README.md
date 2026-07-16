# 💸 Splitwise-lite — Friend-Group Expense Splitter

Log who paid, split bills equally or unequally, and instantly see the **minimum
set of transfers** needed to settle everyone up. Mobile-first, no sign-up.

## Highlights

- **Groups** with named members (no accounts — share the group URL, that's it).
- **Fast expense logging**: pick payer, tap who's in, type amount → equal split by default.
- **Unequal splits**: exact amounts or percentages; exclude anyone who wasn't there.
- **Debt simplification**: collapses cyclic IOUs (A→B→C→A) into the fewest real transfers.
- **Multi-currency**: balances are bucketed per currency (no forced conversion).
- **History feed** with edit/delete; **mark settlements as paid** to update balances.
- **No floating-point bugs**: every amount is stored and computed in integer cents.

## Architecture

```
server/
  settle.js       # PURE money + debt-simplification logic (no I/O) — the tricky part
  settle.test.js  # unit tests for the above (node --test)
  db.js           # JSON-file persistence (atomic writes); swap for SQLite later
  index.js        # Express REST API + serves the built frontend in production
src/              # React (Vite) mobile-first UI
```

The debt-simplification lives in `server/settle.js` as a set of pure functions,
completely separate from the UI and the database, exactly so it can be tested in
isolation. See `settle.test.js`.

## Run it

```bash
npm install

# Development (two processes: API on :3001, Vite UI on :5173 with proxy)
npm run dev
# open http://localhost:5173

# Tests
npm test

# Production (build static UI, serve everything from one Node process on :3001)
npm run build
npm start
# open http://localhost:3001
```

### Self-hosting on Debian

It's a single Node ≥18 process with one JSON file — no native modules, no DB
server. Point a reverse proxy (Caddy/nginx) at `:3001`.

```bash
npm ci && npm run build
DATA_FILE=/var/lib/splitwise-lite/store.json PORT=3001 npm start
```

Environment variables:

| Var         | Default              | Purpose                          |
|-------------|----------------------|----------------------------------|
| `PORT`      | `3001`               | HTTP port                        |
| `DATA_FILE` | `./data/store.json`  | Where the JSON store is written  |

## How debt simplification works

1. Compute each person's **net balance** (total paid − total share of bills),
   per currency. Recorded settlements move debtors back toward zero.
2. Greedily match the biggest creditor with the biggest debtor, emit a transfer,
   repeat. This produces at most *n − 1* transfers and cleanly cancels cycles —
   so "A owes B, B owes C, C owes A" becomes **no transfers at all**.

## API sketch

| Method | Path                                   | Purpose                       |
|--------|----------------------------------------|-------------------------------|
| GET    | `/api/groups`                          | List groups                   |
| POST   | `/api/groups`                          | Create group (+ members)      |
| GET    | `/api/groups/:id`                      | Group + balances + settle-up  |
| POST   | `/api/groups/:id/members`              | Add member                    |
| POST   | `/api/groups/:id/expenses`             | Add expense                   |
| PUT    | `/api/expenses/:id`                    | Edit expense                  |
| DELETE | `/api/expenses/:id`                    | Delete expense                |
| POST   | `/api/groups/:id/settlements`          | Record a settlement as paid   |
| DELETE | `/api/settlements/:id`                 | Undo a settlement             |

Every mutating call returns the fresh group with recomputed balances and
settle-up, so the UI just swaps in the response.
