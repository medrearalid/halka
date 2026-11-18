import { useEffect, useState } from "react";
import { call, on, type UpdateStatus } from "@/ipc";
import { useApp } from "@/state/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Group, Row } from "./SettingsLayout";

/** Current self-update state; the title-bar pill and the settings row both read it. */
export function useUpdateStatus(): UpdateStatus {
  const [s, setS] = useState<UpdateStatus>({ state: "idle" });
  useEffect(() => {
    void call("update_status").then(setS, () => {});
    // fresh closure: the mock keeps listeners in a Set, so reusing setS across StrictMode remounts would unsubscribe both
    return on("update", (u) => setS(u));
  }, []);
  return s;
}

const BASE = "enter mr-2 flex h-6 items-center whitespace-nowrap gap-1.5 rounded-full border px-2.5 text-2xs tracking-tight";

/** Title-bar pill: renders nothing while idle, so a normal session never shifts. */
export function UpdatePill() {
  const s = useUpdateStatus();
  const inCall = useApp((st) => st.snap?.voice != null);
  if (s.state === "idle" || s.state === "checking") return null;

  if (s.state === "downloading")
    return (
      <div role="status" aria-label={`Halka ${s.version} indiriliyor`} className={`${BASE} relative overflow-hidden border-line-2 bg-paper-1 text-ink-2`}>
        <span>Güncelleme indiriliyor</span>
        {s.pct !== null && <span className="w-7 text-right tabular-nums text-ink-1">{s.pct}%</span>}
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-px w-full origin-left bg-copper transition-transform duration-(--dur-2) ease-(--ease-out)"
          style={{ transform: `scaleX(${(s.pct ?? 0) / 100})` }}
        />
      </div>
    );

  if (s.state === "ready")
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void call("update_restart_now")}
            className={`${BASE} border-line-2 bg-paper-1 text-copper hover:bg-copper-soft focus-visible:outline-2 focus-visible:outline-copper active:scale-[.97]`}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-copper" />
            Yeniden başlat
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {inCall
            ? `Halka ${s.version} görüşme bitince kurulacak. Şimdi başlatırsan görüşmeden çıkarsın.`
            : `Halka ${s.version} kurulmaya hazır`}
        </TooltipContent>
      </Tooltip>
    );

  return (
    <div role="alert" className={`${BASE} border-line-2 bg-paper-1 pr-0.5 text-ink-2`}>
      <span aria-hidden className="size-1.5 rounded-full bg-danger" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default rounded-sm focus-visible:outline-2 focus-visible:outline-copper">{s.message}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 font-mono text-2xs break-words" data-selectable>
          {s.detail}
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={() => void call("update_retry")}
        className="h-5 rounded-full px-2 text-ink-1 hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-copper active:scale-[.97]"
      >
        Tekrar dene
      </button>
    </div>
  );
}

/** Settings row: running version plus a manual check. */
export function AppVersion() {
  const s = useUpdateStatus();
  const [version, setVersion] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    void import("@tauri-apps/api/app").then((m) => m.getVersion()).then(setVersion, () => setVersion(null));
  }, []);
  const desc =
    s.state === "checking" ? "Denetleniyor…"
    : s.state === "downloading" ? `Halka ${s.version} indiriliyor`
    : s.state === "ready" ? `Halka ${s.version} kurulmaya hazır`
    : s.state === "error" ? <span data-selectable title={s.detail}>{s.message}: <span className="font-mono">{s.detail}</span></span>
    : asked ? "Halka güncel"
    : "Güncellemeler kendiliğinden kurulur";
  return (
    <Group title="Sürüm">
      <Row label={<span className="tabular-nums">Halka {version ?? "geliştirme"}</span>} desc={desc}>
        {s.state === "ready" ? (
          <Button size="sm" onClick={() => void call("update_restart_now")}>Yeniden başlat</Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={s.state === "checking" || s.state === "downloading"}
            onClick={() => {
              setAsked(true);
              void call("update_retry");
            }}
          >
            Güncellemeleri denetle
          </Button>
        )}
      </Row>
    </Group>
  );
}
