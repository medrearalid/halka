import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@/ipc";
import { useApp } from "@/state/store";
import { parseChangelog, unseenReleases, type Release } from "@/lib/changelog";
import { Button } from "@/components/ui/button";
import changelog from "../../../CHANGELOG.md?raw";

const KEY = "halka.seenVersion";

function readSeen(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function writeSeen(v: string) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // storage blocked: the card simply shows again next launch
  }
}

/** The browser mock runs the newest changelog version (override with ?version=). */
const mockVersion = () =>
  new URLSearchParams(location.search).get("version") ?? parseChangelog(changelog)[0]?.version ?? "0.0.0";

/** First launch after an update: what changed since the last version this profile saw. */
export function WhatsNew() {
  const ready = useApp((s) => s.snap !== null);
  const [notes, setNotes] = useState<{ current: string; list: Release[] } | null>(null);

  useEffect(() => {
    if (!ready) return;
    let dead = false;
    void (isTauri ? getVersion() : Promise.resolve(mockVersion())).then((current) => {
      if (dead) return;
      // a brand-new install (no name chosen yet) has nothing to catch up on
      const name = useApp.getState().snap?.me.name.trim() ?? "";
      if (!name || name === "Anonim") return writeSeen(current);
      const list = unseenReleases(changelog, readSeen(), current);
      if (list.length) setNotes({ current, list });
      else writeSeen(current);
    });
    return () => {
      dead = true;
    };
  }, [ready]);

  if (!notes) return null;
  const close = () => {
    writeSeen(notes.current);
    setNotes(null);
  };
  return (
    <section
      role="dialog"
      aria-labelledby="whats-new-title"
      onKeyDown={(e) => e.key === "Escape" && close()}
      className="glass enter fixed top-12 right-3 z-[90] flex max-h-[min(420px,calc(100dvh-64px))] w-[min(340px,calc(100dvw-24px))] flex-col rounded-lg"
    >
      <header className="flex items-baseline justify-between gap-2 px-3.5 pt-3 pb-1.5">
        <h2 id="whats-new-title" className="text-sm font-semibold tracking-tight text-ink-1">
          Neler değişti
        </h2>
        <span className="font-mono text-2xs tabular-nums text-ink-3">{notes.current}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-1" data-selectable>
        {notes.list.map((r) => (
          <div key={r.version} className="pb-2">
            {notes.list.length > 1 && (
              <div className="pt-1 pb-1 font-mono text-2xs tabular-nums text-ink-3">{r.version}</div>
            )}
            <ul className="flex flex-col gap-1.5">
              {r.items.slice(0, 6).map((it) => (
                <li key={it} className="flex gap-2 text-xs leading-[1.45] text-ink-2">
                  <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-copper" />
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <footer className="flex justify-end border-t border-line px-3 py-2">
        <Button size="sm" onClick={close} autoFocus>
          Tamam
        </Button>
      </footer>
    </section>
  );
}
