import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.js";
import { parseCents, formatCents } from "../../money.js";
import "./ExpenseForm.css";

const CATEGORY_META = [
  { key: "kavinė", icon: "🍽️" },
  { key: "gėrimai", icon: "🍺" },
  { key: "transportas", icon: "🚕" },
  { key: "bilietai", icon: "🎫" },
  { key: "maisto produktai", icon: "🛒" },
  { key: "apgyvendinimas", icon: "🏨" },
  { key: "kita", icon: "🧾" },
];
const today = () => new Date().toISOString().slice(0, 10);

// Typeable combobox: pick a styled suggestion or type any custom category.
function CategoryInput({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocClick);
    return () => document.removeEventListener("pointerdown", onDocClick);
  }, []);

  const q = value.trim().toLowerCase();
  const matches = CATEGORY_META.filter((c) => c.key.includes(q));

  return (
    <div className="combo" ref={wrapRef}>
      <input
        placeholder="maistas, gėrimai, taksi…"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && matches.length > 0 && (
        <ul className="combo-menu">
          {matches.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                className={`combo-item ${c.key === q ? "active" : ""}`}
                onPointerDown={(e) => { e.preventDefault(); onChange(c.key); setOpen(false); }}
              >
                <span className="combo-emoji">{c.icon}</span>
                <span>{c.key}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberSelect({ value, onChange, members }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocClick);
    return () => document.removeEventListener("pointerdown", onDocClick);
  }, []);

  const selected = members.find((m) => m.id === value);

  return (
    <div className="combo" ref={wrapRef}>
      <button
        type="button"
        className="combo-select-btn"
        onClick={() => setOpen(!open)}
      >
        <span>{selected ? selected.name : "Pasirinkti..."}</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="combo-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      {open && (
        <ul className="combo-menu">
          {members.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={`combo-item ${m.id === value ? "active" : ""}`}
                onPointerDown={(e) => { e.preventDefault(); onChange(m.id); setOpen(false); }}
              >
                <span>{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Modal for adding or editing an expense. Defaults are tuned for speed:
// everyone is a participant, split is equal, payer is the first member.
export default function ExpenseForm({ group, expense, onSaved, onClose }) {
  const members = group.members;
  const editing = Boolean(expense);

  const [paidBy, setPaidBy] = useState(expense?.paidBy || members[0]?.id || "");
  const [amount, setAmount] = useState(expense ? (expense.amount / 100).toString() : "");
  const currency = "EUR"; // single-currency app
  const date = expense?.date || today();
  const [category, setCategory] = useState(expense?.category || "");
  const [splitType, setSplitType] = useState(expense?.splitType || "equal");

  // Which members are in on it (for equal split).
  const initialParticipants = expense
    ? new Set(expense.splits.map((s) => s.memberId))
    : new Set(members.map((m) => m.id));
  const [participants, setParticipants] = useState(initialParticipants);

  // Custom rows for amount splits: memberId -> string value.
  const [customValues, setCustomValues] = useState(() => {
    const init = {};
    if (expense && expense.splitType === "amount") {
      for (const s of expense.splits) init[s.memberId] = (s.amount / 100).toString();
    }
    return init;
  });

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const amountCents = parseCents(amount);

  const toggleParticipant = (id) => {
    setParticipants((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Live preview of the split so people can sanity-check before saving.
  const preview = useMemo(() => {
    if (!Number.isInteger(amountCents) || amountCents <= 0) return null;
    if (splitType === "equal") {
      const ids = members.filter((m) => participants.has(m.id)).map((m) => m.id);
      if (ids.length === 0) return null;
      const base = Math.trunc(amountCents / ids.length);
      let rem = amountCents - base * ids.length;
      return ids.map((id, i) => ({ memberId: id, amount: base + (i < rem ? 1 : 0) }));
    }
    if (splitType === "amount") {
      const rows = members
        .filter((m) => customValues[m.id] != null && customValues[m.id] !== "")
        .map((m) => ({ memberId: m.id, amount: parseCents(customValues[m.id]) }));
      return rows;
    }
    return null;
  }, [amountCents, splitType, participants, customValues, members]);

  const previewSum = preview ? preview.reduce((a, s) => a + (s.amount || 0), 0) : null;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!Number.isInteger(amountCents) || amountCents <= 0) return setError("Enter a valid amount");

    const payload = { paidBy, amount: amountCents, currency, date, category, splitType };
    if (splitType === "equal") {
      payload.participants = members.filter((m) => participants.has(m.id)).map((m) => m.id);
      if (payload.participants.length === 0) return setError("Pick at least one participant");
    } else if (splitType === "amount") {
      payload.splits = members
        .filter((m) => customValues[m.id] != null && customValues[m.id] !== "")
        .map((m) => ({ memberId: m.id, amount: parseCents(customValues[m.id]) }));
      if (previewSum !== amountCents) return setError("Custom amounts must add up to the total");
    }

    setBusy(true);
    try {
      const fresh = editing
        ? await api.updateExpense(expense.id, payload)
        : await api.addExpense(group.id, payload);
      onSaved(fresh);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>


        <form onSubmit={submit} className="stack">
          <div className="modal-head">
            <h2>{editing ? "Redaguoti" : "Pridėti mokėjimą"}</h2>
            <button className="icon" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="row">
            <label className="grow">
              Suma
              <div className="amount-input">
                <input
                  autoFocus
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <span className="currency-suffix">€</span>
              </div>
            </label>
          </div>

          <label>
            Kas mokėjo?
            <MemberSelect value={paidBy} onChange={setPaidBy} members={members} />
          </label>

          <div className="row">
            <label className="grow">
              Už ką?
              <CategoryInput value={category} onChange={setCategory} />
            </label>
          </div>

          <div className="split-tabs">
            {[
              ["equal", "Po lygiai"],
              ["amount", "Pagal sumą"],
            ].map(([v, label]) => (
              <button
                type="button"
                key={v}
                className={splitType === v ? "tab active" : "tab"}
                onClick={() => setSplitType(v)}
              >
                {label}
              </button>
            ))}
          </div>

          {splitType === "equal" && (
            <div className="participants">
              <div className="row between">
                <span className="muted small">Kas metasi?</span>
                <div className="mini-actions">
                  <button type="button" className="link" onClick={() => setParticipants(new Set(members.map((m) => m.id)))}>
                    Visi
                  </button>
                  <button type="button" className="link" onClick={() => setParticipants(new Set())}>
                    Niekas
                  </button>
                </div>
              </div>
              <div className="chips">
                {members.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={participants.has(m.id) ? "chip on" : "chip"}
                    onClick={() => toggleParticipant(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {splitType === "amount" && (
            <div className="custom-splits">
              {members.map((m) => (
                <label key={m.id} className="custom-row">
                  <span>{m.name}</span>
                  <div className="suffixed">
                    <input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={customValues[m.id] ?? ""}
                      onChange={(e) =>
                        setCustomValues((prev) => ({ ...prev, [m.id]: e.target.value }))
                      }
                    />
                    <span className="suffix">{currency}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          {preview && (
            <p className={`split-summary ${previewSum === amountCents ? "" : "error"}`}>
              Iš viso: {formatCents(previewSum)}
              {previewSum !== amountCents && amountCents > 0 && (
                <> · needs {formatCents(amountCents)}</>
              )}
            </p>
          )}

          {error && <p className="error">{error}</p>}

          <button className="primary" disabled={busy}>
            {busy ? "Išsaugoma..." : editing ? "Išsaugoti" : "Pridėti"}
          </button>
        </form>
      </div>
    </div>
  );
}
