import type { Id, MemberView, Perm, RoleView, SpaceView } from "@/ipc";
import { useApp } from "@/state/store";

export function useSpace(): SpaceView | null {
  return useApp((s) => s.snap?.spaces.find((x) => x.id === s.space) ?? null);
}

/** `admin` implies every permission. */
export function has(space: SpaceView | null | undefined, perm: Perm): boolean {
  if (!space) return false;
  return space.my_perms.includes("admin") || space.my_perms.includes(perm);
}

export function memberOf(space: SpaceView | null | undefined, id: Id): MemberView | undefined {
  return space?.members.find((m) => m.id === id);
}

export function shortId(id: Id) {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function nameOf(space: SpaceView | null | undefined, id: Id): string {
  return memberOf(space, id)?.name || shortId(id);
}

/** Owner outranks every role; no role = -1. */
export function rankOf(space: SpaceView, m: MemberView | undefined): number {
  if (!m) return -1;
  if (m.is_owner || m.id === space.owner) return Infinity;
  let r = -1;
  for (const rid of m.roles) {
    const role = space.roles.find((x) => x.id === rid);
    if (role && role.rank > r) r = role.rank;
  }
  return r;
}

export function topRole(space: SpaceView, m: MemberView): RoleView | undefined {
  let best: RoleView | undefined;
  for (const rid of m.roles) {
    const role = space.roles.find((x) => x.id === rid);
    if (role && (!best || role.rank > best.rank || (role.rank === best.rank && role.id < best.id))) best = role;
  }
  return best;
}

export function myRank(space: SpaceView, meId: Id): number {
  return rankOf(space, memberOf(space, meId));
}

/** Can I act (kick/ban/assign) on this member? Strictly outranking, never self. */
export function outranks(space: SpaceView, meId: Id, target: MemberView): boolean {
  if (target.id === meId) return false;
  return myRank(space, meId) > rankOf(space, target);
}

export const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
