// Tiny JSON-file persistence layer.
//
// For a 3-15 person friend-group tool this is plenty: the whole dataset is a
// few kilobytes and fits comfortably in memory. Writes are atomic (write to a
// temp file, then rename) so a crash mid-write can't corrupt the store.
//
// Swapping this for SQLite/Postgres later means reimplementing this one module;
// nothing else in the app knows how data is stored.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitEqual } from "./settle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data", "store.json");

const EMPTY = { groups: [], members: [], expenses: [], settlements: [] };

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(EMPTY);
    throw err;
  }
}

let state = load();

function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic on same filesystem
}

export const id = () => randomUUID();

// ---- Groups ---------------------------------------------------------------

export function createGroup(name, memberNames = []) {
  const group = { id: id(), name: name.trim(), createdAt: new Date().toISOString() };
  state.groups.push(group);
  for (const n of memberNames) if (n && n.trim()) addMember(group.id, n);
  persist();
  return getGroup(group.id);
}

export function listGroups() {
  return state.groups
    .map((g) => ({
      ...g,
      members: state.members.filter((m) => m.groupId === g.id),
      expenseCount: state.expenses.filter((e) => e.groupId === g.id).length,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getGroup(groupId) {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return null;
  return {
    ...group,
    members: state.members.filter((m) => m.groupId === groupId),
    expenses: state.expenses
      .filter((e) => e.groupId === groupId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1)),
    settlements: state.settlements
      .filter((s) => s.groupId === groupId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

export function renameGroup(groupId, name) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return null;
  g.name = name.trim();
  persist();
  return getGroup(groupId);
}

export function deleteGroup(groupId) {
  state.groups = state.groups.filter((g) => g.id !== groupId);
  state.members = state.members.filter((m) => m.groupId !== groupId);
  state.expenses = state.expenses.filter((e) => e.groupId !== groupId);
  state.settlements = state.settlements.filter((s) => s.groupId !== groupId);
  persist();
}

// ---- Members --------------------------------------------------------------

export function addMember(groupId, name) {
  const member = { id: id(), groupId, name: name.trim() };
  state.members.push(member);
  persist();
  return member;
}

export function removeMember(groupId, memberId) {
  // Instead of blocking, cleanly re-home this member's expenses onto the people
  // who were part of them, so history and balances stay consistent:
  //  - drop the member from each expense's split and spread their owed share
  //    equally over the remaining participants (sum still equals the total);
  //  - if they were the payer, hand that role to a remaining participant;
  //  - if they were the *only* participant, the expense no longer concerns
  //    anyone, so it's removed.
  const survivors = [];
  for (const exp of state.expenses) {
    if (exp.groupId !== groupId) {
      survivors.push(exp);
      continue;
    }
    const wasPayer = exp.paidBy === memberId;
    const share = exp.splits.find((s) => s.memberId === memberId)?.amount || 0;
    let remaining = exp.splits.filter((s) => s.memberId !== memberId);

    if (!wasPayer && remaining.length === exp.splits.length) {
      survivors.push(exp); // member not involved at all
      continue;
    }
    if (remaining.length === 0) continue; // expense only concerned this member -> drop

    if (share > 0) {
      const extra = splitEqual(share, remaining.length);
      remaining = remaining.map((s, i) => ({ ...s, amount: s.amount + extra[i] }));
    }
    exp.splits = remaining;
    if (wasPayer) exp.paidBy = remaining[0].memberId;
    survivors.push(exp);
  }
  state.expenses = survivors;

  // Settlements are records of real cash between two specific people and can't be
  // meaningfully reassigned, so any involving this member are removed.
  state.settlements = state.settlements.filter(
    (s) => !(s.groupId === groupId && (s.fromMemberId === memberId || s.toMemberId === memberId)),
  );

  state.members = state.members.filter((m) => m.id !== memberId);
  persist();
}

// ---- Expenses -------------------------------------------------------------

export function addExpense(groupId, data) {
  const expense = { id: id(), groupId, createdAt: new Date().toISOString(), ...data };
  state.expenses.push(expense);
  persist();
  return expense;
}

export function updateExpense(expenseId, data) {
  const e = state.expenses.find((x) => x.id === expenseId);
  if (!e) return null;
  Object.assign(e, data, { id: e.id, groupId: e.groupId, createdAt: e.createdAt });
  persist();
  return e;
}

export function deleteExpense(expenseId) {
  const before = state.expenses.length;
  state.expenses = state.expenses.filter((e) => e.id !== expenseId);
  persist();
  return state.expenses.length < before;
}

export function getExpense(expenseId) {
  return state.expenses.find((e) => e.id === expenseId) || null;
}

// ---- Settlements ----------------------------------------------------------

export function addSettlement(groupId, data) {
  const settlement = {
    id: id(),
    groupId,
    status: "paid",
    createdAt: new Date().toISOString(),
    ...data,
  };
  state.settlements.push(settlement);
  persist();
  return settlement;
}

export function getSettlement(settlementId) {
  return state.settlements.find((s) => s.id === settlementId) || null;
}

export function deleteSettlement(settlementId) {
  const before = state.settlements.length;
  state.settlements = state.settlements.filter((s) => s.id !== settlementId);
  persist();
  return state.settlements.length < before;
}

// Test/utility hook.
export function _reset() {
  state = structuredClone(EMPTY);
}
