import React, { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api.js";
import { formatCents } from "../../money.js";
import ExpenseForm from "../ExpenseForm/ExpenseForm.jsx";
import "./GroupView.css";

const SPLIT_LABEL = { equal: "lygiai", amount: "pagal sumą" };

const CATEGORY_ICON = {
  food: "🍽️",
  drinks: "🍺",
  transport: "🚕",
  tickets: "🎫",
  groceries: "🛒",
  stay: "🏨",
  other: "🧾",
};

export default function GroupView() {
  const { groupId } = useParams();
  const [group, setGroup] = useState(null);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [newMember, setNewMember] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getGroup(groupId).then(setGroup).catch((e) => setError(e.message));
  }, [groupId]);

  const nameOf = useMemo(() => {
    const map = new Map((group?.members || []).map((m) => [m.id, m.name]));
    return (id) => map.get(id) || "?";
  }, [group]);

  if (error) return <ErrorScreen message={error} />;
  if (!group) return <div className="app"><p className="muted">Loading…</p></div>;

  const anyActivity = group.expenses.length > 0 || group.settlements.length > 0;

  async function addMember(e) {
    e.preventDefault();
    if (!newMember.trim()) return;
    try {
      setGroup(await api.addMember(group.id, newMember.trim()));
      setNewMember("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeMember(id) {
    try {
      setGroup(await api.removeMember(group.id, id));
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteExpense(id) {
    setGroup(await api.deleteExpense(id));
  }

  async function settleTransfer(currency, t) {
    setGroup(
      await api.addSettlement(group.id, {
        fromMemberId: t.from,
        toMemberId: t.to,
        amount: t.amount,
        currency,
      }),
    );
  }

  async function undoSettlement(id) {
    setGroup(await api.deleteSettlement(id));
  }

  function share() {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="app group">
      <header className="topbar">
        <Link to="/" className="back">← Atgal</Link>
        <h1>{group.name}</h1>

      </header>

      {/* THE headline: who owes who, minimal transfers. */}
      <section className="card settle">
        <h2>Skolos</h2>
        {!anyActivity && <p className="muted">Nėra skolų.</p>}
        {group.settleUp.map((bucket) => {
          const owedSomething = bucket.transfers.length > 0;
          return (
            <div key={bucket.currency} className="currency-block">
              {group.settleUp.length > 1 && <h3 className="currency-label">{bucket.currency}</h3>}
              {owedSomething ? (
                <ul className="transfers">
                  {bucket.transfers.map((t, i) => (
                    <li key={i} className="transfer">
                      <span className="who">
                        <b>{nameOf(t.from)}</b> → <b>{nameOf(t.to)}</b>
                      </span>
                      <span className="amt">{formatCents(t.amount, bucket.currency)}</span>
                      <button className="settle-btn" onClick={() => settleTransfer(bucket.currency, t)}>
                        Apmokėta
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                anyActivity && <p className="all-settled">✅ Visi atsiskaitę {bucket.currency}</p>
              )}

              <div className="balances">
                <div className="muted small balances-title">Balansas</div>
                <ul>
                  {[...bucket.balances]
                    .sort((a, b) => b.amount - a.amount)
                    .map((b) => (
                      <li key={b.memberId} className="balance-row">
                        <span>{nameOf(b.memberId)}</span>
                        <span className={b.amount > 0 ? "pos" : b.amount < 0 ? "neg" : "muted"}>
                          {b.amount > 0 ? "laukia " : b.amount < 0 ? "skoloje " : "atsiskaitęs "}
                          {b.amount !== 0 && formatCents(Math.abs(b.amount), bucket.currency)}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          );
        })}
      </section>

      <button
        className="fab"
        onClick={() => {
          if (group.members.length === 0) return alert("Add at least one member first.");
          setEditing(null);
          setShowForm(true);
        }}
      >
        + Pridėti
      </button>

      {/* History feed */}
      <section className="card">
        <h2>Išlaidos</h2>
        {group.expenses.length === 0 && <p className="muted">Nieko nėra.</p>}
        <ul className="feed">
          {group.expenses.map((e) => (
            <li key={e.id} className="feed-item">
              <div className="feed-icon">{CATEGORY_ICON[e.category] || "🧾"}</div>
              <div className="feed-main">
                <div className="feed-title">{e.category}</div>
                <div className="muted small">
                  {nameOf(e.paidBy)} mokėjo
                </div>
              </div>
              <span className="feed-amt">{formatCents(e.amount, e.currency)}</span>
              <div className="feed-actions">
                <button className="icon" title="Edit" onClick={() => { setEditing(e); setShowForm(true); }}>✏️</button>
                <button className="icon" title="Delete" onClick={() => deleteExpense(e.id)}>🗑️</button>
              </div>
            </li>
          ))}
        </ul>

        {group.settlements.length > 0 && (
          <>
            <h3 className="muted small">Recorded settlements</h3>
            <ul className="feed">
              {group.settlements.map((s) => (
                <li key={s.id} className="feed-item">
                  <div className="feed-icon">✅</div>
                  <div className="feed-main">
                    <div className="feed-title">{nameOf(s.fromMemberId)} paid {nameOf(s.toMemberId)}</div>
                  </div>
                  <span className="feed-amt">{formatCents(s.amount, s.currency)}</span>
                  <div className="feed-actions">
                    <button className="icon" title="Undo" onClick={() => undoSettlement(s.id)}>↩️</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Members */}
      <section className="card">
        <ul className="member-list">
          {group.members.map((m) => (
            <li key={m.id}>
              <span>{m.name}</span>
              <button className="icon" title="Remove" onClick={() => removeMember(m.id)}>✕</button>
            </li>
          ))}
        </ul>
        <form onSubmit={addMember} className="row add-member">
          <input
            className="grow"
            placeholder="Pridėti žmogų…"
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
          />
          <button className="secondary">+</button>
        </form>
      </section>

      {showForm && group.members.length > 0 && (
        <ExpenseForm
          group={group}
          expense={editing}
          onClose={() => setShowForm(false)}
          onSaved={(fresh) => {
            setGroup(fresh);
            setShowForm(false);
          }}
        />
      )}
      <div className="row between">
        <button className="link" onClick={share}>{copied ? "Copied!" : "Share link"}</button>
      </div>
      <footer className="muted small">
        <span className="credit">© {new Date().getFullYear()} · matuzaite</span>
      </footer>
    </div>
  );
}

function ErrorScreen({ message }) {
  return (
    <div className="app">
      <p className="error">{message}</p>
      <Link to="/" className="link">← Atgal</Link>
    </div>
  );
}
