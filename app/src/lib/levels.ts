// Voice levels and every level-driven visual share one animation loop.
// It runs at display rate only while something moves, drops to a 15 fps idle tick
// when a hook asks for one (the orb layer breathing), and stops while hidden.
import { on, type Id } from "@/ipc";

/** "busy": animate at display rate · "idle": slow tick is enough · "off": nothing to draw */
export type FrameHook = (now: number, reducedMotion: boolean) => "busy" | "idle" | "off";

const target = new Map<Id, number>();
const current = new Map<Id, number>();
const els = new Map<Id, Set<HTMLElement>>();
const hooks = new Set<FrameHook>();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const IDLE_MS = 1000 / 15;
let lastUpdate = 0;
let lastFrame = 0;
let raf = 0;
let timer = 0;

reducedMotion.addEventListener("change", () => start());
document.addEventListener("visibilitychange", () => start());

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
  const changed: Id[] = [];
  let moving = false;
  let audible = false;
  for (const id of new Set([...current.keys(), ...target.keys(), ...els.keys()])) {
    const t = stale ? 0 : (target.get(id) ?? 0);
    const c = current.get(id) ?? 0;
    // fast attack, slower release
    const retention = t > c ? 0.5 : 0.84;
    let v = t + (c - t) * retention ** (elapsed / (1000 / 60));
    if (Math.abs(v - t) < 0.003) v = t;
    if (v !== c) changed.push(id);
    if (v !== t) moving = true;
    if (v > 0) audible = true;
    if (v === 0) current.delete(id);
    else current.set(id, v);
  }

  // Hooks read layout first; style writes come after so no frame forces a second layout.
  let busy = false;
  let idle = false;
  if (!document.hidden) {
    for (const h of hooks) {
      const r = h(now, reducedMotion.matches);
      busy ||= r === "busy";
      idle ||= r === "idle";
    }
  }
  for (const id of changed) {
    const v = (current.get(id) ?? 0).toFixed(3);
    for (const el of els.get(id) ?? []) el.style.setProperty("--lvl", v);
  }

  if (document.hidden) return;
  if (moving || busy) raf = requestAnimationFrame(frame);
  else if (idle && !reducedMotion.matches) timer = window.setTimeout(wake, IDLE_MS);
  else if (audible && !stale) timer = window.setTimeout(wake, 260); // notice when events stop
}

function wake() {
  timer = 0;
  if (!raf) raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || document.hidden || (!els.size && !hooks.size && !current.size)) return;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

/** Ref callback that keeps `--lvl` (0..1) on an element for a member's voice level. */
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

/** Run `hook` inside the shared loop; returns the unsubscribe function. */
export function addFrameHook(hook: FrameHook) {
  hooks.add(hook);
  start();
  return () => {
    hooks.delete(hook);
  };
}

/** Ask for a frame soon (e.g. an orb was added or changed colour). */
export const requestFrame = start;
