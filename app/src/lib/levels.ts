// Voice levels: written straight into CSS variables by one rAF loop. Never touches React state.
import { on, type Id } from "@/ipc";

const target = new Map<Id, number>();
const current = new Map<Id, number>();
const els = new Map<Id, Set<HTMLElement>>();
let lastUpdate = 0;
let raf = 0;

on("levels", (lv) => {
  lastUpdate = performance.now();
  target.clear();
  for (const k in lv) target.set(k, Math.max(0, Math.min(1, lv[k])));
  start();
});

function frame() {
  raf = 0;
  const stale = performance.now() - lastUpdate > 250; // no events: decay to silence
  let moving = false;
  for (const [id, set] of els) {
    const t = stale ? 0 : (target.get(id) ?? 0);
    const c = current.get(id) ?? 0;
    // fast attack, slower release
    let v = c + (t - c) * (t > c ? 0.5 : 0.16);
    if (Math.abs(v - t) < 0.003) v = t;
    current.set(id, v);
    if (v !== t || v > 0) moving = true;
    const s = v.toFixed(3);
    for (const el of set) el.style.setProperty("--lvl", s);
  }
  if (moving || !stale) raf = requestAnimationFrame(frame);
}

function start() {
  if (!raf && els.size) raf = requestAnimationFrame(frame);
}

/** Ref callback (React 19 cleanup form): the element gets `--lvl` (0..1) for member `id`. */
export function levelRef(id: Id) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    let set = els.get(id);
    if (!set) els.set(id, (set = new Set()));
    set.add(el);
    el.style.setProperty("--lvl", (current.get(id) ?? 0).toFixed(3));
    start();
    return () => {
      set.delete(el);
      if (!set.size) els.delete(id);
    };
  };
}

export function levelOf(id: Id): number {
  return current.get(id) ?? 0;
}
