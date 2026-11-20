import { useState } from "react";
import { Copy } from "lucide-react";
import { call } from "@/ipc";
import { useSpace } from "@/lib/space";
import { copy } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "./common";
import { useSubmit } from "./forms";

const EXPIRY = [
  { value: 3_600_000, label: "1 saat" },
  { value: 86_400_000, label: "1 gün" },
  { value: 7 * 86_400_000, label: "7 gün" },
  { value: 0, label: "Süresiz" },
];
const USES = [
  { value: 1, label: "1 kişi" },
  { value: 5, label: "5" },
  { value: 25, label: "25" },
  { value: 0, label: "Sınırsız" },
];

export function InviteCreator({ compact }: { compact?: boolean }) {
  const space = useSpace();
  const [expiry, setExpiry] = useState(7 * 86_400_000);
  const [uses, setUses] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const { busy, error, run } = useSubmit(
    () => call("create_invite", { space: space!.id, expiresInMs: expiry || null, maxUses: uses || null }),
    (c) => {
      setCode(c);
      void copy(c, "Davet kodu kopyalandı");
    },
  );
  if (!space) return null;
  return (
    <div className={compact ? "grid grid-cols-[auto_auto_minmax(0,1fr)] items-end gap-3" : "flex flex-col gap-3"}>
      <Field label="Geçerlilik">
        <Segmented value={expiry} options={EXPIRY} onChange={(v) => (setExpiry(v), setCode(null))} />
      </Field>
      <Field label="Kullanım sınırı">
        <Segmented value={uses} options={USES} onChange={(v) => (setUses(v), setCode(null))} />
      </Field>
      <div className={compact ? "flex justify-end" : "contents"}>
        {!code && (
          <Button onClick={() => void run()} aria-busy={busy}>
            Davet kodu oluştur
          </Button>
        )}
      </div>
      {error && <p className="col-span-3 text-xs text-danger">{error}</p>}
      {code && (
        <div className="enter col-span-3 flex min-w-0 items-center gap-1.5 rounded-md border border-line-2 bg-paper-0 py-1 pr-1 pl-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-1" data-selectable>
            {code}
          </code>
          <Button size="sm" variant="secondary" onClick={() => void copy(code, "Davet kodu kopyalandı")}>
            <Copy /> Kopyala
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCode(null)}>
            Yeni
          </Button>
        </div>
      )}
    </div>
  );
}
