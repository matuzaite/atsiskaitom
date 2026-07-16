// Persistence layer.
//
// The whole dataset for a friend-group tool is a few kilobytes, so we store it
// as a single JSON blob and load/save the whole thing per operation. Two
// backends, chosen at runtime:
//   - Upstash Redis (serverless-friendly, HTTP) when its env vars are present
//     — this is what runs on Vercel, where the filesystem is ephemeral.
//   - A local JSON file otherwise — zero-setup local development.
//
// Every exported function is async: it reads the current state, mutates it, and
// writes it back. Nothing else in the app knows how data is stored.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "@upstash/redis";
import { splitEqual } from "./settle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMPTY = { groups: [], members: [], expenses: [], settlements: [] };

// ---- Storage backend ------------------------------------------------------

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const STORE_KEY = process.env.STORE_KEY || "atsiskaitom:store";

const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data", "store.json");

/** Read the whole store. */
async function read() {
  if (redis) {
    const data = await redis.get(STORE_KEY); // @upstash/redis parses JSON for us
    return data ? { ...EMPTY, ...data } : structuredClone(EMPTY);
  }
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(EMPTY);
    throw err;
  }
}

/** Write the whole store. */
async function write(state) {
  if (redis) {
    await redis.set(STORE_KEY, state);
    return;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic on same filesystem
}

export const id = () => randomUUID();

// ---- Pure projections (operate on an already-loaded state) ----------------

function projectGroup(state, groupId) {
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

// ---- Groups ---------------------------------------------------------------

export async function createGroup(name, memberNames = []) {
  const state = await read();
  const group = { id: id(), name: name.trim(), createdAt: new Date().toISOString() };
  state.groups.push(group);
  for (const n of memberNames) {
    if (n && n.trim()) state.members.push({ id: id(), groupId: group.id, name: n.trim() });
  }
  await write(state);
  return projectGroup(state, group.id);
}

export async function listGroups() {
  const state = await read();
  return state.groups
    .map((g) => ({
      ...g,
      members: state.members.filter((m) => m.groupId === g.id),
      expenseCount: state.expenses.filter((e) => e.groupId === g.id).length,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getGroup(groupId) {
  const state = await read();
  return projectGroup(state, groupId);
}

export async function renameGroup(groupId, name) {
  const state = await read();
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return null;
  g.name = name.trim();
  await write(state);
  return projectGroup(state, groupId);
}

export async function deleteGroup(groupId) {
  const state = await read();
  state.groups = state.groups.filter((g) => g.id !== groupId);
  state.members = state.members.filter((m) => m.groupId !== groupId);
  state.expenses = state.expenses.filter((e) => e.groupId !== groupId);
  state.settlements = state.settlements.filter((s) => s.groupId !== groupId);
  await write(state);
}

// ---- Members --------------------------------------------------------------

export async function addMember(groupId, name) {
  const state = await read();
  const member = { id: id(), groupId, name: name.trim() };
  state.members.push(member);
  await write(state);
  return member;
}

export async function removeMember(groupId, memberId) {
  const state = await read();
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
  await write(state);
}

// ---- Expenses -------------------------------------------------------------

export async function addExpense(groupId, data) {
  const state = await read();
  const expense = { id: id(), groupId, createdAt: new Date().toISOString(), ...data };
  state.expenses.push(expense);
  await write(state);
  return expense;
}

export async function updateExpense(expenseId, data) {
  const state = await read();
  const e = state.expenses.find((x) => x.id === expenseId);
  if (!e) return null;
  Object.assign(e, data, { id: e.id, groupId: e.groupId, createdAt: e.createdAt });
  await write(state);
  return e;
}

export async function deleteExpense(expenseId) {
  const state = await read();
  const before = state.expenses.length;
  state.expenses = state.expenses.filter((e) => e.id !== expenseId);
  await write(state);
  return state.expenses.length < before;
}

export async function getExpense(expenseId) {
  const state = await read();
  return state.expenses.find((e) => e.id === expenseId) || null;
}

// ---- Settlements ----------------------------------------------------------

export async function addSettlement(groupId, data) {
  const state = await read();
  const settlement = {
    id: id(),
    groupId,
    status: "paid",
    createdAt: new Date().toISOString(),
    ...data,
  };
  state.settlements.push(settlement);
  await write(state);
  return settlement;
}

export async function getSettlement(settlementId) {
  const state = await read();
  return state.settlements.find((s) => s.id === settlementId) || null;
}

export async function deleteSettlement(settlementId) {
  const state = await read();
  const before = state.settlements.length;
  state.settlements = state.settlements.filter((s) => s.id !== settlementId);
  await write(state);
  return state.settlements.length < before;
}

// Test/utility hook.
export async function _reset() {
  await write(structuredClone(EMPTY));
}
