import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Id } from "@/ipc";
import { addFrameHook, levelOf, requestFrame } from "@/lib/levels";
import { createOrbRenderer, type OrbDraw } from "@/lib/orbGl";
import { cn } from "@/lib/utils";

type Entry = { el: HTMLElement; id: Id; rgb: [number, number, number]; seed: number; silent: boolean };

export type OrbLayerApi = {
  /** Draw a GPU orb around `el`; returns the remover. */
  add(el: HTMLElement, id: Id, color: number, silent: boolean): () => void;
};

const Ctx = createContext<OrbLayerApi | null>(null);

/** The stage's orb layer, or null where orbs fall back to the CSS hairline. */
export function useOrbLayer() {
  return useContext(Ctx);
}

function seedOf(id: Id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const rgbOf = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

/** One canvas behind a stage; every live orb inside `children` is drawn by it in one draw call. */
export function OrbStage({ className, children }: { className?: string; children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [api, setApi] = useState<OrbLayerApi | null>(null);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const renderer = createOrbRenderer(cv);
    if (!renderer) return; // no WebGL2: OrbAvatar keeps its CSS hairline
    const entries = new Set<Entry>();
    const orbs: OrbDraw[] = [];
    let drawn = false;
    let settleUntil = 0; // seats glide for 220 ms after joins/leaves: follow them at full rate
    const settle = () => {
      settleUntil = performance.now() + 400;
      requestFrame();
    };
    const off = addFrameHook((now, reduced) => {
      if (!entries.size) {
        if (drawn) renderer.draw([], null, 0, cv.width, cv.height, 1);
        drawn = false;
        return "off";
      }
      const box = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(box.width * dpr));
      const h = Math.max(1, Math.round(box.height * dpr));
      orbs.length = 0;
      let loud: OrbDraw | null = null;
      for (const e of entries) {
        const r = e.el.getBoundingClientRect();
        if (!r.width) continue;
        const o: OrbDraw = {
          x: (r.left + r.width / 2 - box.left) * dpr,
          y: (r.top + r.height / 2 - box.top) * dpr,
          r: (r.width / 2) * dpr,
          rgb: e.rgb,
          level: e.silent ? 0 : levelOf(e.id),
          seed: e.seed,
          silent: e.silent,
        };
        orbs.push(o);
        if (o.level > (loud?.level ?? 0.04)) loud = o;
      }
      const ambient = loud && { ...loud, r: Math.max(w, h) * 0.55, level: loud.level * 0.075 };
      renderer.draw(orbs, ambient, reduced ? 0 : now / 1000, w, h, dpr);
      drawn = true;
      return loud || now < settleUntil ? "busy" : "idle";
    });
    setApi({
      add(el, id, color, silent) {
        const e: Entry = { el, id, rgb: rgbOf(color), seed: seedOf(id), silent };
        entries.add(e);
        settle();
        return () => {
          entries.delete(e);
          settle();
        };
      },
    });
    const ro = new ResizeObserver(settle);
    ro.observe(cv);
    // GPU reset / driver hiccup: fall back to CSS hairlines rather than show a dead canvas
    const lost = (e: Event) => {
      e.preventDefault();
      off();
      cv.style.display = "none";
      setApi(null);
    };
    cv.addEventListener("webglcontextlost", lost);
    return () => {
      cv.removeEventListener("webglcontextlost", lost);
      ro.disconnect();
      off();
      setApi(null);
      renderer.dispose();
    };
  }, []);

  return (
    <div className={cn("orb-stage relative isolate", className)}>
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 -z-10 size-full" />
      <Ctx.Provider value={api}>{children}</Ctx.Provider>
    </div>
  );
}
