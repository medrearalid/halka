import { useState } from "react";
import { ArrowLeft, Plus, Ticket } from "lucide-react";
import { call } from "@/ipc";
import { useApp } from "@/state/store";
import { Button } from "@/components/ui/button";
import { RingMark } from "./common";
import { CreateSpaceForm, JoinForm, useSubmit } from "./forms";

export function Onboarding() {
  const me = useApp((s) => s.snap!.me);
  const needsName = !me.name.trim() || me.name === "Anonim";
  const [step, setStep] = useState<"choose" | "create" | "join">("choose");

  return (
    <div className="relative grid h-full place-items-center overflow-auto bg-paper-0 px-4">
      <svg className="pointer-events-none absolute top-1/2 left-1/2 size-[640px] -translate-x-1/2 -translate-y-1/2 max-[700px]:hidden" viewBox="0 0 640 640" aria-hidden>
        <circle cx="320" cy="320" r="300" fill="none" stroke="var(--ring-line)" />
        <circle cx="320" cy="320" r="288" fill="none" stroke="var(--ring-line)" strokeDasharray="1 9" />
        {[0, 1, 2, 3, 4].map((i) => {
          const t = (2 * Math.PI * i) / 5;
          return <circle key={i} cx={320 - Math.sin(t) * 300} cy={320 + Math.cos(t) * 300} r={i === 0 ? 5 : 3.5} fill={i === 0 ? "var(--copper)" : "var(--line-2)"} />;
        })}
      </svg>
      <div key={needsName ? "name" : step} className="enter relative flex w-full max-w-[340px] flex-col gap-6 py-10">
        <div className="flex flex-col gap-3">
          <RingMark size={30} className="text-copper" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{needsName ? "Halka’ya hoş geldin" : `Merhaba ${me.name}`}</h1>
            <p className="mt-1 text-[13px] text-ink-2">Sunucu yok. Konuşmaların doğrudan arkadaşlarınla aranda.</p>
          </div>
        </div>

        {needsName ? (
          <NameStep />
        ) : step === "choose" ? (
          <div className="flex flex-col gap-2">
            <Choice icon={<Plus className="size-4" />} title="Yeni halka oluştur" body="Arkadaşlarını davet edeceğin yeni bir alan." onClick={() => setStep("create")} />
            <Choice icon={<Ticket className="size-4" />} title="Davet koduyla katıl" body="Biri sana halka1… ile başlayan bir kod verdiyse." onClick={() => setStep("join")} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <button onClick={() => setStep("choose")} className="flex w-fit items-center gap-1 text-xs text-ink-3 hover:text-ink-1">
              <ArrowLeft className="size-3" /> Geri
            </button>
            <div className="text-[13px] font-medium">{step === "create" ? "Yeni halka oluştur" : "Davet koduyla katıl"}</div>
            {step === "create" ? <CreateSpaceForm autoFocus /> : <JoinForm autoFocus />}
          </div>
        )}

        <p className="text-2xs text-ink-3">
          Güvenlik kodun <span className="font-mono text-ink-2">{me.code}</span>
        </p>
      </div>
    </div>
  );
}

function NameStep() {
  const [name, setName] = useState("");
  const { busy, error, run } = useSubmit(() => call("set_name", { name: name.trim() }));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void run();
      }}
    >
      <label className="text-xs font-medium text-ink-2" htmlFor="ob-name">
        Arkadaşların seni nasıl görsün?
      </label>
      <input id="ob-name" className="field h-8" placeholder="Adın" value={name} maxLength={32} autoFocus onChange={(e) => setName(e.target.value)} />
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" size="lg" disabled={!name.trim()} aria-busy={busy}>
        Devam
      </Button>
    </form>
  );
}

function Choice({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex items-start gap-3 rounded-lg border border-line-2 bg-paper-1 p-3 text-left transition-colors duration-150 hover:border-copper/50 hover:bg-paper-2"
    >
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-paper-3 text-ink-2 transition-colors group-hover:text-copper">{icon}</span>
      <span>
        <span className="block text-[13px] font-medium tracking-tight">{title}</span>
        <span className="block text-xs text-ink-3">{body}</span>
      </span>
    </button>
  );
}
