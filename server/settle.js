// Pure, side-effect-free money + debt-simplification logic.
//
// All monetary values are handled as INTEGER CENTS to avoid floating-point
// rounding bugs. Nothing in this file touches the DB, the network, or the UI,
// which is what makes it easy to unit-test in isolation.

/**
 * Split an integer `amount` (cents) equally between `n` shares.
 * Any leftover cents (amount % n) are distributed one-by-one to the first
 * shares, so the parts always sum back to exactly `amount`.
 *
 * splitEqual(1000, 3) -> [334, 333, 333]
 *
 * @param {number} amount total in cents
 * @param {number} n number of shares (> 0)
 * @returns {number[]} array of `n` integer-cent shares
 */
export function splitEqual(amount, n) {
  if (!Number.isInteger(amount)) throw new Error("amount must be integer cents");
  if (!Number.isInteger(n) || n <= 0) throw new Error("n must be a positive integer");
  const base = Math.trunc(amount / n);
  let remainder = amount - base * n; // works for negative amounts too
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  const shares = new Array(n).fill(base);
  for (let i = 0; i < remainder; i++) shares[i] += step;
  return shares;
}

/**
 * Split by percentages (each in "basis points" or plain percent numbers).
 * Percentages are given as numbers that should sum to 100. To stay exact we
 * work in cents and hand any rounding remainder to the largest weight(s).
 *
 * @param {number} amount total in cents
 * @param {number[]} percents e.g. [50, 25, 25]
 * @returns {number[]} integer-cent shares summing to `amount`
 */
export function splitByPercent(amount, percents) {
  const totalPct = percents.reduce((a, b) => a + b, 0);
  if (Math.abs(totalPct - 100) > 1e-9) {
    throw new Error(`percentages must sum to 100 (got ${totalPct})`);
  }
  // Compute floored shares, then distribute the leftover cents to the entries
  // with the largest fractional part (classic largest-remainder method).
  const raw = percents.map((p) => (amount * p) / 100);
  const floored = raw.map((x) => Math.floor(x));
  let remainder = amount - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const shares = floored.slice();
  for (let k = 0; k < remainder; k++) shares[order[k % order.length].i] += 1;
  return shares;
}

/**
 * Net balance per member, per currency.
 *
 * Sign convention:
 *   positive => the member is OWED money (a creditor / paid more than their share)
 *   negative => the member OWES money (a debtor)
 *
 * An expense credits the payer with the full amount and debits every member in
 * the split by their share. A recorded settlement (from -> to) moves the debtor
 * back toward zero: `from` paid real money, so their balance goes up by amount,
 * and `to` received it, so their balance goes down by amount.
 *
 * @param {{id:string}[]} members
 * @param {object[]} expenses
 * @param {object[]} settlements only status === "paid" settlements affect balances
 * @returns {Map<string, Map<string, number>>} currency -> (memberId -> cents)
 */
export function computeBalances(members, expenses, settlements = []) {
  /** @type {Map<string, Map<string, number>>} */
  const byCurrency = new Map();
  const bump = (currency, memberId, delta) => {
    if (!byCurrency.has(currency)) byCurrency.set(currency, new Map());
    const m = byCurrency.get(currency);
    m.set(memberId, (m.get(memberId) || 0) + delta);
  };

  for (const exp of expenses) {
    bump(exp.currency, exp.paidBy, exp.amount);
    for (const s of exp.splits) bump(exp.currency, s.memberId, -s.amount);
  }

  for (const st of settlements) {
    if (st.status !== "paid") continue;
    bump(st.currency, st.fromMemberId, st.amount);
    bump(st.currency, st.toMemberId, -st.amount);
  }

  // Ensure every member appears (0 balance) in every currency that has activity,
  // so the UI can show a complete roster.
  for (const [, m] of byCurrency) {
    for (const mem of members) if (!m.has(mem.id)) m.set(mem.id, 0);
  }
  return byCurrency;
}

/**
 * Debt simplification (a.k.a. minimum cash flow).
 *
 * Given net balances for a single currency, produce a small set of transfers
 * that settles everyone. We greedily match the biggest creditor with the
 * biggest debtor each round. This does not always find the theoretical minimum
 * (that problem is NP-hard), but it is optimal for the common cyclic cases
 * (A->B->C->A collapses to nothing) and produces at most n-1 transfers, which
 * is dramatically fewer than tracking every pairwise IOU.
 *
 * @param {Map<string, number>|Record<string, number>} balances memberId -> cents
 * @returns {{from:string, to:string, amount:number}[]}
 */
export function simplifyDebts(balances) {
  const entries =
    balances instanceof Map ? [...balances.entries()] : Object.entries(balances);

  const debtors = []; // negative balances -> they must pay
  const creditors = []; // positive balances -> they must receive
  for (const [id, cents] of entries) {
    if (cents < 0) debtors.push({ id, amount: -cents });
    else if (cents > 0) creditors.push({ id, amount: cents });
  }

  // Largest first for a stable, sensible ordering.
  debtors.sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1));
  creditors.sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1));

  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > 0) {
      transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
    }
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return transfers;
}

/**
 * Convenience: full settle-up view across all currencies used in the group.
 *
 * @returns {{currency:string, balances:{memberId:string, amount:number}[],
 *            transfers:{from:string, to:string, amount:number}[]}[]}
 */
export function settleUp(members, expenses, settlements = []) {
  const byCurrency = computeBalances(members, expenses, settlements);
  const result = [];
  for (const [currency, balMap] of byCurrency) {
    result.push({
      currency,
      balances: [...balMap.entries()].map(([memberId, amount]) => ({ memberId, amount })),
      transfers: simplifyDebts(balMap),
    });
  }
  // Deterministic order (EUR-ish default first, then alphabetical).
  result.sort((a, b) => (a.currency < b.currency ? -1 : 1));
  return result;
}
