// Deterministic identity colour + initials from a member id (no images).
const HUES = [28, 52, 78, 110, 150, 178, 200, 228, 345, 8];

export function hueOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < Math.min(id.length, 16); i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return HUES[(h >>> 0) % HUES.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const s = parts.length === 1 ? [...parts[0]].slice(0, 2).join("") : [...parts[0]][0] + [...parts[1]][0];
  return s.toLocaleUpperCase("tr-TR");
}
