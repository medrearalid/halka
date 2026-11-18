import { useState } from "react";
import { call, errText, type Id } from "@/ipc";
import { useApp } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { enableRelay } from "@/lib/relay";
import { fail } from "@/lib/actions";
import { ConnExplainer } from "./common";

function useSubmit<T>(fn: () => Promise<T>, done?: (v: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // not `done?.(await fn())`: optional call skips evaluating its argument when done is undefined
      const v = await fn();
      done?.(v);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function CreateSpaceForm({ onDone, autoFocus }: { onDone?: (id: Id) => void; autoFocus?: boolean }) {
  const [name, setName] = useState("");
  const [relayRequired, setRelayRequired] = useState(false);
  const relayActive = useApp((s) => s.snap?.active_relay_only ?? false);
  const { busy, error, run } = useSubmit(
    () => call("create_space", { name: name.trim(), relayRequired }),
    async (id) => {
      useApp.getState().select(id);
      onDone?.(id);
      // a relay-required halka is useless on a direct endpoint: switch over now and land back in it
      if (relayRequired && !relayActive) await enableRelay().catch(fail);
    },
  );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void run();
      }}
    >
      <input
        className="field"
        placeholder="Halkanın adı, ör. Kanka Grubu"
        value={name}
        maxLength={48}
        autoFocus={autoFocus}
        onChange={(e) => setName(e.target.value)}
        aria-label="Halka adı"
      />
      <label className="flex items-start gap-2.5 py-1">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-ink-1">Relay şart</span>
          <span className="block text-2xs text-ink-3">Kapalıysa üyeler doğrudan bağlanır.
            {relayActive ? "" : " Açıp oluşturursan uygulama yeniden başlar."}
          </span>
        </span>
        <Switch checked={relayRequired} onCheckedChange={setRelayRequired} aria-label="Relay şart" />
      </label>
      <details className="text-2xs text-ink-3">
        <summary className="w-fit cursor-pointer rounded-sm hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-copper">Relay ile doğrudan bağlantı arasındaki fark</summary>
        <ConnExplainer className="mt-1.5 rounded-md border border-line bg-paper-1 p-2.5" />
      </details>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" disabled={!name.trim()} aria-busy={busy}>
        {busy ? "Oluşturuluyor…" : "Halka oluştur"}
      </Button>
    </form>
  );
}

export function JoinForm({ onDone, autoFocus }: { onDone?: (id: Id) => void; autoFocus?: boolean }) {
  const [code, setCode] = useState("");
  const valid = code.trim().startsWith("halka:");
  const { busy, error, run } = useSubmit(
    () => call("join_space", { code: code.trim() }),
    (id) => {
      useApp.getState().select(id);
      onDone?.(id);
    },
  );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void run();
      }}
    >
      <input
        className="field font-mono text-xs"
        placeholder="halka:…"
        value={code}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => setCode(e.target.value)}
        aria-label="Davet kodu"
        aria-invalid={code.trim().length > 4 && !valid}
      />
      {error?.includes("relay şart") ? (
        <RelayGate join={code.trim()} />
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : (
        <p className="text-2xs text-ink-3">Arkadaşından aldığın davet kodunu yapıştır. Katılmak birkaç saniye sürebilir.</p>
      )}
      <Button type="submit" disabled={!valid} aria-busy={busy}>
        {busy ? "Halkaya bağlanılıyor…" : "Katıl"}
      </Button>
    </form>
  );
}

/** One action for a relay-required halka: hide the IP, relaunch, come back here. */
export function RelayGate({ join, note = true }: { join?: string; note?: boolean }) {
  const { busy, error, run } = useSubmit(() => enableRelay(join));
  return (
    <div className="grid justify-items-center gap-2">
      {note && <p className="text-xs text-warn">Bu halkada relay şart. IP’ni gizleyince uygulama yeniden başlar ve kaldığın yere döner.</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="button" variant="outline" className="w-fit" disabled={busy} aria-busy={busy} onClick={() => void run()}>
        {busy ? "Yeniden başlatılıyor…" : "IP’mi gizle ve yeniden başlat"}
      </Button>
    </div>
  );
}

export { useSubmit };
