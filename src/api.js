// Thin fetch wrapper around the REST API. Every mutating call returns the
// fresh group (with derived balances + settle-up), so the UI just replaces
// its group state with whatever comes back.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  listGroups: () => request("GET", "/api/groups"),
  createGroup: (name, members) => request("POST", "/api/groups", { name, members }),
  getGroup: (id) => request("GET", `/api/groups/${id}`),
  deleteGroup: (id) => request("DELETE", `/api/groups/${id}`),

  addMember: (groupId, name) => request("POST", `/api/groups/${groupId}/members`, { name }),
  removeMember: (groupId, memberId) => request("DELETE", `/api/groups/${groupId}/members/${memberId}`),

  addExpense: (groupId, payload) => request("POST", `/api/groups/${groupId}/expenses`, payload),
  updateExpense: (expenseId, payload) => request("PUT", `/api/expenses/${expenseId}`, payload),
  deleteExpense: (expenseId) => request("DELETE", `/api/expenses/${expenseId}`),

  addSettlement: (groupId, payload) => request("POST", `/api/groups/${groupId}/settlements`, payload),
  deleteSettlement: (id) => request("DELETE", `/api/settlements/${id}`),
};
