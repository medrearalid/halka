import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/ipc";
import { RingMark } from "./common";

/** Window chrome: drag area plus three window controls. Close hides to the tray. */
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
    <header data-tauri-drag-region className="flex h-10 shrink-0 select-none items-center border-b border-line bg-paper-0 pr-2 pl-3">
      <RingMark size={13} className="pointer-events-none text-copper" />
      <span data-tauri-drag-region className="ml-2 text-xs font-medium tracking-tight text-ink-2">
        Halka
      </span>
      <div data-tauri-drag-region className="h-full flex-1" />
      <div role="group" aria-label="Pencere kontrolleri" className="flex items-center gap-0.5 rounded-full border border-line-2 bg-paper-1 p-0.5">
        <WindowButton label="Simge durumuna küçült" onClick={act((w) => w.minimize())} tone="ink">
          <path d="M4 8h8" />
        </WindowButton>
        <WindowButton label={max ? "Önceki boyuta getir" : "Büyüt"} onClick={act((w) => w.toggleMaximize())} tone="copper">
          {max ? (
            <>
              <path d="M6.5 3.5h5a1 1 0 0 1 1 1v5" />
              <rect x="3.5" y="6.5" width="6" height="6" rx="1" />
            </>
          ) : (
            <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
          )}
        </WindowButton>
        <WindowButton label="Kapat (sistem tepsisine gizle)" onClick={act((w) => w.close())} tone="danger">
          <path d="m5 5 6 6m0-6-6 6" />
        </WindowButton>
      </div>
    </header>
  );
}

const TONES = {
  ink: "text-ink-2 hover:bg-paper-3 hover:text-ink-1 active:bg-paper-4",
  copper: "text-copper hover:bg-copper-soft active:bg-copper active:text-copper-ink",
  danger: "text-ink-2 hover:bg-danger-soft hover:text-danger active:bg-danger active:text-paper-0",
};

function WindowButton({ label, onClick, tone, children }: { label: string; onClick: () => void; tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-7 w-9 place-items-center rounded-full transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-copper ${TONES[tone]}`}
    >
      <svg viewBox="0 0 16 16" className="pointer-events-none size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
