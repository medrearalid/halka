import type { Id, RoleView } from "@/ipc/contract";

export function moveRole(roles: RoleView[], space: Id, role: Id, target: Id): RoleView[] | undefined {
  const ordered = roles
    .filter((r) => r.id !== space)
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  const from = ordered.findIndex((r) => r.id === role);
  const to = ordered.findIndex((r) => r.id === target);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const ranks = new Map(ordered.map((r, index) => [r.id, ordered.length - index]));
  return roles.map((r) => ({ ...r, rank: ranks.get(r.id) ?? r.rank }));
}
