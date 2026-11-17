import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/ipc";
import { RingMark } from "./common";

/** Window chrome: drag area plus three ring-dot controls. Close hides to the tray. */
export function TitleBar() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    const w = getCurrentWindow();
    const sync = () => void w.isMaximized().then(setMax, () => {});
    sync();
    const off = w.onResized(sync);
    return () => void off.then((f) => f());
  }, []);
  const act = (f: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    if (isTauri) void f(getCurrentWindow()).catch(() => {});
  };

  return (
    <header data-tauri-drag-region className="flex h-8 shrink-0 select-none items-center border-b border-line bg-paper-0 pr-2 pl-3">
      <RingMark size={13} className="pointer-events-none text-copper" />
      <span data-tauri-drag-region className="ml-2 text-xs font-medium tracking-tight text-ink-2">
        Halka
      </span>
      <div data-tauri-drag-region className="h-full flex-1" />
      <div className="group/ctl flex items-center gap-2">
        <Dot label="Simge durumuna küçült" onClick={act((w) => w.minimize())} tone="ink">
          <path d="M3 6h6" />
        </Dot>
        <Dot label={max ? "Önceki boyuta getir" : "Büyüt"} onClick={act((w) => w.toggleMaximize())} tone="copper">
          {max ? <path d="M4 3.5h4.5V8M3 4.5h4.5V9H3z" /> : <rect x="3" y="3" width="6" height="6" rx="1" />}
        </Dot>
        <Dot label="Kapat (tepsiye küçültür)" onClick={act((w) => w.close())} tone="danger">
          <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
        </Dot>
      </div>
    </header>
  );
}

const TONES = {
  ink: "hover:bg-ink-2 hover:text-paper-0",
  copper: "hover:bg-copper hover:text-paper-0",
  danger: "hover:bg-danger hover:text-paper-0",
};

function Dot({ label, onClick, tone, children }: { label: string; onClick: () => void; tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-[14px] place-items-center rounded-full bg-paper-3 text-transparent ring-1 ring-line-2 transition-colors duration-150 group-hover/ctl:text-ink-3 focus-visible:outline-2 focus-visible:outline-copper ${TONES[tone]}`}
    >
      <svg viewBox="0 0 12 12" className="size-[10px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
