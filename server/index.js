import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { settleUp, splitEqual, splitByPercent } from "./settle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const CATEGORIES = ["food", "drinks", "transport", "tickets", "groceries", "stay", "other"];

// Wrap handlers so thrown errors — sync OR async — become clean JSON responses.
// (Using try/catch around `await` also catches synchronous throws, which a bare
// `Promise.resolve(fn()).catch()` would miss because fn() runs before the wrap.)
const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message || "Bad request" });
  }
};

const fail = (msg, status = 400) => {
  throw Object.assign(new Error(msg), { status });
};

/**
 * Turn a client-supplied expense payload into a validated, cents-based record.
 * Supported splitType values:
 *   - "equal":   split `amount` equally across `participants` (member ids)
 *   - "amount":  explicit `splits: [{memberId, amount}]` in cents
 *   - "percent": `splits: [{memberId, percent}]`, percents must sum to 100
 */
function buildExpense(group, body) {
  const memberIds = new Set(group.members.map((m) => m.id));

  const amount = Math.round(Number(body.amount));
  if (!Number.isInteger(amount) || amount <= 0) fail("amount must be a positive number of cents");
  if (!memberIds.has(body.paidBy)) fail("paidBy must be a member of the group");

  const currency = (body.currency || "EUR").toUpperCase().slice(0, 3);
  const date = body.date || new Date().toISOString().slice(0, 10);
  // Category doubles as the label now: free text, but fall back to "other".
  const category = (body.category || "").toString().slice(0, 60).trim() || "other";
  const splitType = body.splitType || "equal";

  let splits;
  if (splitType === "equal") {
    const participants = (body.participants || []).filter((id) => memberIds.has(id));
    if (participants.length === 0) fail("select at least one participant");
    const parts = splitEqual(amount, participants.length);
    splits = participants.map((memberId, i) => ({ memberId, amount: parts[i] }));
  } else if (splitType === "percent") {
    const rows = (body.splits || []).filter((s) => memberIds.has(s.memberId));
    if (rows.length === 0) fail("provide at least one split row");
    const parts = splitByPercent(amount, rows.map((s) => Number(s.percent)));
    splits = rows.map((s, i) => ({ memberId: s.memberId, amount: parts[i] }));
  } else if (splitType === "amount") {
    const rows = (body.splits || []).filter((s) => memberIds.has(s.memberId));
    if (rows.length === 0) fail("provide at least one split row");
    splits = rows.map((s) => ({ memberId: s.memberId, amount: Math.round(Number(s.amount)) }));
    const sum = splits.reduce((a, s) => a + s.amount, 0);
    if (sum !== amount) fail(`splits sum to ${sum} but expense is ${amount} cents`);
  } else {
    fail(`unknown splitType: ${splitType}`);
  }

  return { paidBy: body.paidBy, amount, currency, date, category, splitType, splits };
}

// Attach the derived settle-up view to a group response.
function withDerived(group) {
  return { ...group, settleUp: settleUp(group.members, group.expenses, group.settlements) };
}

// ---- Group routes ---------------------------------------------------------

app.get("/api/groups", h(async (req, res) => res.json(await db.listGroups())));

app.post(
  "/api/groups",
  h(async (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) fail("group name is required");
    res.status(201).json(withDerived(await db.createGroup(name, req.body.members || [])));
  }),
);

app.get(
  "/api/groups/:id",
  h(async (req, res) => {
    const group = await db.getGroup(req.params.id);
    if (!group) fail("group not found", 404);
    res.json(withDerived(group));
  }),
);

app.patch(
  "/api/groups/:id",
  h(async (req, res) => {
    const group = await db.renameGroup(req.params.id, req.body.name || "");
    if (!group) fail("group not found", 404);
    res.json(withDerived(group));
  }),
);

app.delete(
  "/api/groups/:id",
  h(async (req, res) => {
    await db.deleteGroup(req.params.id);
    res.status(204).end();
  }),
);

// ---- Member routes --------------------------------------------------------

app.post(
  "/api/groups/:id/members",
  h(async (req, res) => {
    const group = await db.getGroup(req.params.id);
    if (!group) fail("group not found", 404);
    const name = (req.body.name || "").trim();
    if (!name) fail("member name is required");
    await db.addMember(group.id, name);
    res.status(201).json(withDerived(await db.getGroup(group.id)));
  }),
);

app.delete(
  "/api/groups/:id/members/:memberId",
  h(async (req, res) => {
    await db.removeMember(req.params.id, req.params.memberId);
    res.json(withDerived(await db.getGroup(req.params.id)));
  }),
);

// ---- Expense routes -------------------------------------------------------

app.post(
  "/api/groups/:id/expenses",
  h(async (req, res) => {
    const group = await db.getGroup(req.params.id);
    if (!group) fail("group not found", 404);
    await db.addExpense(group.id, buildExpense(group, req.body));
    res.status(201).json(withDerived(await db.getGroup(group.id)));
  }),
);

app.put(
  "/api/expenses/:id",
  h(async (req, res) => {
    const existing = await db.getExpense(req.params.id);
    if (!existing) fail("expense not found", 404);
    const group = await db.getGroup(existing.groupId);
    await db.updateExpense(existing.id, buildExpense(group, req.body));
    res.json(withDerived(await db.getGroup(group.id)));
  }),
);

app.delete(
  "/api/expenses/:id",
  h(async (req, res) => {
    const existing = await db.getExpense(req.params.id);
    if (!existing) fail("expense not found", 404);
    await db.deleteExpense(existing.id);
    res.json(withDerived(await db.getGroup(existing.groupId)));
  }),
);

// ---- Settlement routes ----------------------------------------------------

app.post(
  "/api/groups/:id/settlements",
  h(async (req, res) => {
    const group = await db.getGroup(req.params.id);
    if (!group) fail("group not found", 404);
    const memberIds = new Set(group.members.map((m) => m.id));
    const { fromMemberId, toMemberId } = req.body;
    const amount = Math.round(Number(req.body.amount));
    if (!memberIds.has(fromMemberId) || !memberIds.has(toMemberId)) fail("from/to must be group members");
    if (fromMemberId === toMemberId) fail("from and to must differ");
    if (!Number.isInteger(amount) || amount <= 0) fail("amount must be positive cents");
    await db.addSettlement(group.id, {
      fromMemberId,
      toMemberId,
      amount,
      currency: (req.body.currency || "EUR").toUpperCase().slice(0, 3),
      date: req.body.date || new Date().toISOString().slice(0, 10),
    });
    res.status(201).json(withDerived(await db.getGroup(group.id)));
  }),
);

app.delete(
  "/api/settlements/:id",
  h(async (req, res) => {
    const existing = await db.getSettlement(req.params.id);
    if (!existing) fail("settlement not found", 404);
    await db.deleteSettlement(existing.id);
    res.json(withDerived(await db.getGroup(existing.groupId)));
  }),
);

app.get("/api/health", (req, res) => res.json({ ok: true, categories: CATEGORIES }));

// ---- Static frontend (production) ----------------------------------------

const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (req, res, next) => {
  res.sendFile(path.join(distDir, "index.html"), (err) => (err ? next() : null));
});

const PORT = process.env.PORT || 3001;
// On Vercel the app runs as a serverless function (imported by api/index.js), so
// it must NOT bind a port. Only listen for local dev / a self-hosted Node process.
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Expense splitter API on http://localhost:${PORT}`));
}

export default app;
