import type { Id } from "@/ipc/contract";

/**
 * Seat geometry — shared contract with the core's stereo panner.
 * N = everyone in the room (self included). Self sits at seat 0 = 6 o'clock.
 * Others, by member id ascending, take seats i = 1..N-1 clockwise (as seen on screen):
 *   θᵢ = 2π·i / N      x = −sin θᵢ,  y = cos θᵢ   (screen coords, y down; unit circle)
 *   pan = x = −sin θᵢ  (−1 hard left … +1 hard right)
 */
export function seatAngles(selfId: Id, ids: Id[]): { id: Id; theta: number }[] {
  const others = ids.filter((x) => x !== selfId).sort();
  const n = others.length + 1;
  return [{ id: selfId, theta: 0 }, ...others.map((id, i) => ({ id, theta: (2 * Math.PI * (i + 1)) / n }))];
}
