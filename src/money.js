// Client-side money helpers. The server is the source of truth and always
// speaks integer cents; these just format for display and parse user input.

// Single-currency app: everything is EUR.

/** Format integer cents as e.g. "€14.50". */
export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const value = (Math.abs(cents) / 100).toFixed(2);
  return `${sign}€${value}`;
}

/** Parse a user string like "14.5" or "14,50" into integer cents (or NaN). */
export function parseCents(input) {
  if (input == null) return NaN;
  const normalized = String(input).trim().replace(",", ".");
  if (normalized === "") return NaN;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
