import { useState } from "react";
import { call, errText, type Id } from "@/ipc";
import { useApp } from "@/state/store";
import { Button } from "@/components/ui/button";

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
  const { busy, error, run } = useSubmit(
    () => call("create_space", { name: name.trim() }),
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
      {error ? (
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

export { useSubmit };
