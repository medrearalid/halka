import { expect, test } from "bun:test";
import { layout } from "../src/components/WelcomeCrowd";

const cast = { order: [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15], phases: Array(12).fill(0) };

for (const [w, h] of [[1500, 370], [880, 230], [2560, 420]]) {
  test(`even crowd at ${w}x${h}`, () => {
    const d = layout(w, h, cast);
    const figs = Array.from({ length: d.length / 8 }, (_, i) => d.slice(i * 8, i * 8 + 8));
    const rows = [...new Set(figs.map((f) => f[2]))];
    expect(rows.length).toBe(2);
    for (const size of rows) {
      const xs = figs.filter((f) => f[2] === size).map((f) => f[0]).sort((a, b) => a - b);
      // covers the width edge to edge
      expect(xs[0]).toBeLessThan(size * 0.75 * 0.5);
      expect(xs[xs.length - 1]).toBeGreaterThan(w - size * 0.75 * 0.5);
      // no gap wider than a bust between neighbours
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThan(size * 0.75);
    }
    // a repeated drawing is never within 11 figures of itself, left to right
    const byX = [...figs].sort((a, b) => a[0] - b[0]).map((f) => f[4]);
    byX.forEach((id, i) => expect(byX.slice(i + 1, i + 12)).not.toContain(id));
    for (const f of figs) {
      expect(f[1] - f[2]).toBeGreaterThanOrEqual(0); // head stays inside the canvas
      expect(Math.abs(f[3])).toBe(1);
    }
  });
}
