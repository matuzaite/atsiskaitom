// Persistence layer. Two interchangeable backends, chosen at runtime:
//
//   - Supabase (Postgres over HTTP) when SUPABASE_URL + a service key are set.
//     This is what runs on Vercel, where the filesystem is ephemeral.
//   - A local JSON file otherwise — zero-setup local development.
//
// Both expose the same async API; nothing else in the app knows which is used.
// The relational schema lives in supabase/schema.sql.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { splitEqual } from "./settle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMPTY = { groups: [], members: [], expenses: [], settlements: [] };

export const id = () => randomUUID();

// ===========================================================================
// File backend (local dev)
// ===========================================================================

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data", "store.json");

function fileRead() {
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(EMPTY);
    throw err;
  }
}

function fileWrite(state) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

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

const fileImpl = {
  async createGroup(name, memberNames = []) {
    const state = fileRead();
    const group = { id: id(), name: name.trim(), createdAt: new Date().toISOString() };
    state.groups.push(group);
    for (const n of memberNames) {
      if (n && n.trim()) state.members.push({ id: id(), groupId: group.id, name: n.trim() });
    }
    fileWrite(state);
    return projectGroup(state, group.id);
  },
  async listGroups() {
    const state = fileRead();
    return state.groups
      .map((g) => ({
        ...g,
        members: state.members.filter((m) => m.groupId === g.id),
        expenseCount: state.expenses.filter((e) => e.groupId === g.id).length,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },
  async getGroup(groupId) {
    return projectGroup(fileRead(), groupId);
  },
  async renameGroup(groupId, name) {
    const state = fileRead();
    const g = state.groups.find((x) => x.id === groupId);
    if (!g) return null;
    g.name = name.trim();
    fileWrite(state);
    return projectGroup(state, groupId);
  },
  async deleteGroup(groupId) {
    const state = fileRead();
    state.groups = state.groups.filter((g) => g.id !== groupId);
    state.members = state.members.filter((m) => m.groupId !== groupId);
    state.expenses = state.expenses.filter((e) => e.groupId !== groupId);
    state.settlements = state.settlements.filter((s) => s.groupId !== groupId);
    fileWrite(state);
  },
  async addMember(groupId, name) {
    const state = fileRead();
    const member = { id: id(), groupId, name: name.trim() };
    state.members.push(member);
    fileWrite(state);
    return member;
  },
  async removeMember(groupId, memberId) {
    const state = fileRead();
    state.expenses = rehomeExpenses(state.expenses, groupId, memberId);
    state.settlements = state.settlements.filter(
      (s) => !(s.groupId === groupId && (s.fromMemberId === memberId || s.toMemberId === memberId)),
    );
    state.members = state.members.filter((m) => m.id !== memberId);
    fileWrite(state);
  },
  async addExpense(groupId, data) {
    const state = fileRead();
    const expense = { id: id(), groupId, createdAt: new Date().toISOString(), ...data };
    state.expenses.push(expense);
    fileWrite(state);
    return expense;
  },
  async updateExpense(expenseId, data) {
    const state = fileRead();
    const e = state.expenses.find((x) => x.id === expenseId);
    if (!e) return null;
    Object.assign(e, data, { id: e.id, groupId: e.groupId, createdAt: e.createdAt });
    fileWrite(state);
    return e;
  },
  async deleteExpense(expenseId) {
    const state = fileRead();
    const before = state.expenses.length;
    state.expenses = state.expenses.filter((e) => e.id !== expenseId);
    fileWrite(state);
    return state.expenses.length < before;
  },
  async getExpense(expenseId) {
    return fileRead().expenses.find((e) => e.id === expenseId) || null;
  },
  async addSettlement(groupId, data) {
    const state = fileRead();
    const settlement = { id: id(), groupId, status: "paid", createdAt: new Date().toISOString(), ...data };
    state.settlements.push(settlement);
    fileWrite(state);
    return settlement;
  },
  async getSettlement(settlementId) {
    return fileRead().settlements.find((s) => s.id === settlementId) || null;
  },
  async deleteSettlement(settlementId) {
    const state = fileRead();
    const before = state.settlements.length;
    state.settlements = state.settlements.filter((s) => s.id !== settlementId);
    fileWrite(state);
    return state.settlements.length < before;
  },
  async _reset() {
    fileWrite(structuredClone(EMPTY));
  },
};

// Re-home a removed member's expenses onto the remaining participants so history
// and balances stay consistent. Returns the new expense list for the group's
// members (expenses of other groups pass through untouched). Shared by both
// backends; operates on app-shaped expense objects.
function rehomeExpenses(expenses, groupId, memberId) {
  const survivors = [];
  for (const exp of expenses) {
    if (exp.groupId !== groupId) {
      survivors.push(exp);
      continue;
    }
    const wasPayer = exp.paidBy === memberId;
    const share = exp.splits.find((s) => s.memberId === memberId)?.amount || 0;
    let remaining = exp.splits.filter((s) => s.memberId !== memberId);

    if (!wasPayer && remaining.length === exp.splits.length) {
      survivors.push(exp); // member not involved
      continue;
    }
    if (remaining.length === 0) continue; // expense only concerned this member -> drop

    if (share > 0) {
      const extra = splitEqual(share, remaining.length);
      remaining = remaining.map((s, i) => ({ ...s, amount: s.amount + extra[i] }));
    }
    survivors.push({ ...exp, splits: remaining, paidBy: wasPayer ? remaining[0].memberId : exp.paidBy });
  }
  return survivors;
}

// ===========================================================================
// Supabase backend (production)
// ===========================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
    : null;

// Throw a clean error on query failure; otherwise return the data.
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data;
}

// Row (snake_case) -> app shape (camelCase).
const toGroup = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });
const toMember = (r) => ({ id: r.id, groupId: r.group_id, name: r.name });
const toExpense = (r) => ({
  id: r.id,
  groupId: r.group_id,
  paidBy: r.paid_by,
  amount: r.amount,
  currency: r.currency,
  date: r.date,
  category: r.category,
  splitType: r.split_type,
  splits: r.splits,
  createdAt: r.created_at,
});
const toSettlement = (r) => ({
  id: r.id,
  groupId: r.group_id,
  fromMemberId: r.from_member_id,
  toMemberId: r.to_member_id,
  amount: r.amount,
  currency: r.currency,
  date: r.date,
  status: r.status,
  createdAt: r.created_at,
});

async function sbGetGroup(groupId) {
  const { data: group, error } = await supabase.from("groups").select("*").eq("id", groupId).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  if (!group) return null;

  const members = unwrap(await supabase.from("members").select("*").eq("group_id", groupId));
  const expenses = unwrap(await supabase.from("expenses").select("*").eq("group_id", groupId));
  const settlements = unwrap(await supabase.from("settlements").select("*").eq("group_id", groupId));

  return {
    ...toGroup(group),
    members: members.map(toMember),
    expenses: expenses
      .map(toExpense)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1)),
    settlements: settlements.map(toSettlement).sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

const supabaseImpl = {
  async createGroup(name, memberNames = []) {
    const group = unwrap(await supabase.from("groups").insert({ name: name.trim() }).select().single());
    const rows = memberNames.filter((n) => n && n.trim()).map((n) => ({ group_id: group.id, name: n.trim() }));
    if (rows.length) unwrap(await supabase.from("members").insert(rows));
    return sbGetGroup(group.id);
  },
  async listGroups() {
    const groups = unwrap(await supabase.from("groups").select("*").order("created_at", { ascending: false }));
    const members = unwrap(await supabase.from("members").select("*"));
    const expenses = unwrap(await supabase.from("expenses").select("group_id"));
    return groups.map((g) => ({
      ...toGroup(g),
      members: members.filter((m) => m.group_id === g.id).map(toMember),
      expenseCount: expenses.filter((e) => e.group_id === g.id).length,
    }));
  },
  getGroup: sbGetGroup,
  async renameGroup(groupId, name) {
    const rows = unwrap(await supabase.from("groups").update({ name: name.trim() }).eq("id", groupId).select());
    if (!rows.length) return null;
    return sbGetGroup(groupId);
  },
  async deleteGroup(groupId) {
    // ON DELETE CASCADE removes members/expenses/settlements.
    unwrap(await supabase.from("groups").delete().eq("id", groupId));
  },
  async addMember(groupId, name) {
    const row = unwrap(
      await supabase.from("members").insert({ group_id: groupId, name: name.trim() }).select().single(),
    );
    return toMember(row);
  },
  async removeMember(groupId, memberId) {
    const expenses = unwrap(await supabase.from("expenses").select("*").eq("group_id", groupId)).map(toExpense);
    const survivors = rehomeExpenses(expenses, groupId, memberId);
    const survivorIds = new Set(survivors.map((e) => e.id));

    const dropped = expenses.filter((e) => !survivorIds.has(e.id)).map((e) => e.id);
    if (dropped.length) unwrap(await supabase.from("expenses").delete().in("id", dropped));

    // Persist any re-homed splits / payer changes.
    for (const e of survivors) {
      const original = expenses.find((o) => o.id === e.id);
      if (original && (original.paidBy !== e.paidBy || original.splits !== e.splits)) {
        unwrap(await supabase.from("expenses").update({ splits: e.splits, paid_by: e.paidBy }).eq("id", e.id));
      }
    }

    unwrap(
      await supabase
        .from("settlements")
        .delete()
        .eq("group_id", groupId)
        .or(`from_member_id.eq.${memberId},to_member_id.eq.${memberId}`),
    );
    unwrap(await supabase.from("members").delete().eq("id", memberId));
  },
  async addExpense(groupId, data) {
    const row = unwrap(
      await supabase
        .from("expenses")
        .insert({
          group_id: groupId,
          paid_by: data.paidBy,
          amount: data.amount,
          currency: data.currency,
          date: data.date,
          category: data.category,
          split_type: data.splitType,
          splits: data.splits,
        })
        .select()
        .single(),
    );
    return toExpense(row);
  },
  async updateExpense(expenseId, data) {
    const rows = unwrap(
      await supabase
        .from("expenses")
        .update({
          paid_by: data.paidBy,
          amount: data.amount,
          currency: data.currency,
          date: data.date,
          category: data.category,
          split_type: data.splitType,
          splits: data.splits,
        })
        .eq("id", expenseId)
        .select(),
    );
    return rows.length ? toExpense(rows[0]) : null;
  },
  async deleteExpense(expenseId) {
    const rows = unwrap(await supabase.from("expenses").delete().eq("id", expenseId).select("id"));
    return rows.length > 0;
  },
  async getExpense(expenseId) {
    const { data, error } = await supabase.from("expenses").select("*").eq("id", expenseId).maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data ? toExpense(data) : null;
  },
  async addSettlement(groupId, data) {
    const row = unwrap(
      await supabase
        .from("settlements")
        .insert({
          group_id: groupId,
          from_member_id: data.fromMemberId,
          to_member_id: data.toMemberId,
          amount: data.amount,
          currency: data.currency,
          date: data.date,
          status: "paid",
        })
        .select()
        .single(),
    );
    return toSettlement(row);
  },
  async getSettlement(settlementId) {
    const { data, error } = await supabase.from("settlements").select("*").eq("id", settlementId).maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return data ? toSettlement(data) : null;
  },
  async deleteSettlement(settlementId) {
    const rows = unwrap(await supabase.from("settlements").delete().eq("id", settlementId).select("id"));
    return rows.length > 0;
  },
  async _reset() {
    unwrap(await supabase.from("groups").delete().neq("id", "00000000-0000-0000-0000-000000000000"));
  },
};

// ===========================================================================

const impl = supabase ? supabaseImpl : fileImpl;
export default impl;
