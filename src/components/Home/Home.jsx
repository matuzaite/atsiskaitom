import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api.js";
import "./Home.css";

export default function Home() {
  const [groups, setGroups] = useState([]);
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.listGroups().then(setGroups).catch((e) => setError(e.message));
  }, []);

  async function remove(e, group) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.deleteGroup(group.id);
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function create(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const memberNames = members.split(",").map((s) => s.trim()).filter(Boolean);
      const group = await api.createGroup(name.trim(), memberNames);
      navigate(`/g/${group.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="app home">
      <header className="topbar">
        <h1>💸 Atsiskaitom</h1>
        <p className="muted">Kas mokėjo? kur? už ką? ir kiek kas kam skoloj?</p>
      </header>

      <section className="card">
        <form onSubmit={create} className="stack">
          <label>
            Proga
            <input
              autoFocus
              placeholder="Vilnius, ežerai, kempingas..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            Žmonės ( per kablelį )
            <input
              placeholder="Austėja, Ieva, Tomas"
              value={members}
              onChange={(e) => setMembers(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? "Kraunasi..." : "Sukurti grupę"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Progos</h2>
        {groups.length === 0 && <p className="muted">Jokių progų.</p>}
        <ul className="group-list">
          {groups.map((g) => (
            <li key={g.id} className="group-row">
              <Link to={`/g/${g.id}`} className="group-link">
                <span className="group-name">{g.name}</span>
                <span className="muted">
                  {g.members.length} {g.members.length === 1 ? "žmogus" : "žmonės"} · {g.expenseCount}{" "}
                  {g.expenseCount < 10 ? "išlaidos" : "išlaidų"}
                </span>
              </Link>
              <button className="icon delete-group" title="Delete group" onClick={(e) => remove(e, g)}>
                🗑️
              </button>
            </li>
          ))}
        </ul>
      </section>

      <footer className="muted small">
        Patarimas: Pasidalink progos nuoroda — kas netingi gali prisijungti ir matyti išlaidas.
        <span className="credit">© {new Date().getFullYear()} · matuzaite</span>
      </footer>
    </div>
  );
}
