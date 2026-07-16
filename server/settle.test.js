import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitEqual,
  splitByPercent,
  computeBalances,
  simplifyDebts,
  settleUp,
} from "./settle.js";

test("splitEqual distributes remainder cents and sums exactly", () => {
  assert.deepEqual(splitEqual(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitEqual(1000, 4), [250, 250, 250, 250]);
  assert.deepEqual(splitEqual(1, 3), [1, 0, 0]);
  for (const [amt, n] of [[1000, 3], [9999, 7], [1, 4], [12345, 11]]) {
    const parts = splitEqual(amt, n);
    assert.equal(parts.length, n);
    assert.equal(parts.reduce((a, b) => a + b, 0), amt, `sum for ${amt}/${n}`);
  }
});

test("splitByPercent sums exactly and rejects bad totals", () => {
  assert.deepEqual(splitByPercent(1000, [50, 50]), [500, 500]);
  const parts = splitByPercent(1000, [33.33, 33.33, 33.34]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000);
  assert.throws(() => splitByPercent(1000, [50, 40]));
});

test("computeBalances: equal dinner, payer is owed the others' shares", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const expenses = [
    {
      currency: "EUR",
      paidBy: "a",
      amount: 3000,
      splits: [
        { memberId: "a", amount: 1000 },
        { memberId: "b", amount: 1000 },
        { memberId: "c", amount: 1000 },
      ],
    },
  ];
  const bal = computeBalances(members, expenses).get("EUR");
  assert.equal(bal.get("a"), 2000); // paid 3000, owed 1000
  assert.equal(bal.get("b"), -1000);
  assert.equal(bal.get("c"), -1000);
});

test("computeBalances: paid settlement moves debtor toward zero", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const expenses = [
    {
      currency: "EUR",
      paidBy: "a",
      amount: 2000,
      splits: [
        { memberId: "a", amount: 1000 },
        { memberId: "b", amount: 1000 },
      ],
    },
  ];
  const settlements = [
    { currency: "EUR", fromMemberId: "b", toMemberId: "a", amount: 1000, status: "paid" },
  ];
  const bal = computeBalances(members, expenses, settlements).get("EUR");
  assert.equal(bal.get("a"), 0);
  assert.equal(bal.get("b"), 0);
});

test("simplifyDebts collapses a cycle A->B->C->A to nothing", () => {
  // Net balances all zero after a perfect cycle.
  assert.deepEqual(simplifyDebts({ a: 0, b: 0, c: 0 }), []);
});

test("simplifyDebts produces at most n-1 transfers and conserves money", () => {
  const balances = { a: 500, b: 300, c: -400, d: -400 };
  const transfers = simplifyDebts(balances);
  assert.ok(transfers.length <= 3);

  // Apply transfers and confirm everyone lands on zero.
  const net = { ...balances };
  for (const t of transfers) {
    net[t.from] += t.amount; // debtor pays -> balance rises
    net[t.to] -= t.amount; // creditor receives -> balance falls
    assert.ok(t.amount > 0);
  }
  for (const k of Object.keys(net)) assert.equal(net[k], 0, `member ${k} settled`);
});

test("settleUp buckets by currency", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const expenses = [
    { currency: "EUR", paidBy: "a", amount: 1000, splits: [{ memberId: "a", amount: 500 }, { memberId: "b", amount: 500 }] },
    { currency: "USD", paidBy: "b", amount: 2000, splits: [{ memberId: "a", amount: 1000 }, { memberId: "b", amount: 1000 }] },
  ];
  const view = settleUp(members, expenses);
  const eur = view.find((v) => v.currency === "EUR");
  const usd = view.find((v) => v.currency === "USD");
  assert.deepEqual(eur.transfers, [{ from: "b", to: "a", amount: 500 }]);
  assert.deepEqual(usd.transfers, [{ from: "a", to: "b", amount: 1000 }]);
});
