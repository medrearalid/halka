// Voice levels and orb rotation share one animation frame loop.
import { on, type Id } from "@/ipc";
import { hueOf } from "./avatar";

const target = new Map<Id, number>();
const current = new Map<Id, number>();
const els = new Map<Id, Map<HTMLElement, number | null>>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let lastUpdate = 0;
let lastFrame = 0;
let raf = 0;

reducedMotion.addEventListener("change", start);

on("levels", (lv) => {
  lastUpdate = performance.now();
  target.clear();
  for (const k in lv) target.set(k, Math.max(0, Math.min(1, lv[k])));
  start();
});

function frame(now: number) {
  raf = 0;
  const elapsed = Math.max(0, Math.min(now - lastFrame, 50));
  lastFrame = now;
  const stale = now - lastUpdate > 250; // no events: decay to silence
  let moving = false;
  for (const [id, elements] of els) {
    const t = stale ? 0 : (target.get(id) ?? 0);
    const c = current.get(id) ?? 0;
    // fast attack, slower release
    const retention = t > c ? 0.5 : 0.84;
    let v = t + (c - t) * retention ** (elapsed / (1000 / 60));
    if (Math.abs(v - t) < 0.003) v = t;
    current.set(id, v);
    if (v !== t) moving = true;
    for (const [el, angle] of elements) {
      if (v !== c) el.style.setProperty("--lvl", v.toFixed(3));
      if (angle === null || reducedMotion.matches) continue;
      const level = el.dataset.silent === "true" ? 0 : v;
      // Integrate the speed so a change in loudness never jumps the highlight.
      const next = (angle + (10 + level * 70) * elapsed / 1000) % 360;
      elements.set(el, next);
      el.style.setProperty("--orb-angle", `${next.toFixed(2)}deg`);
      moving = true;
    }
  }
  if (moving || (!stale && els.size)) raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || !els.size) return;
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

/** Ref callback for a member's level, with optional orb rotation. */
export function levelRef(id: Id, effect?: "orb") {
  return (el: HTMLElement | null) => {
    if (!el) return;
    let elements = els.get(id);
    if (!elements) els.set(id, (elements = new Map()));
    const angle = effect === "orb" ? hueOf(id) : null;
    elements.set(el, angle);
    el.style.setProperty("--lvl", (current.get(id) ?? 0).toFixed(3));
    if (angle !== null) el.style.setProperty("--orb-angle", `${angle}deg`);
    start();
    return () => {
      elements.delete(el);
      if (!elements.size) els.delete(id);
    };
  };
}

export function levelOf(id: Id): number {
  return current.get(id) ?? 0;
}
