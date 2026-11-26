import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, Pencil, Plus, Shield, ShieldCheck, Ticket, Volume2, VolumeX } from "lucide-react";
import { call, type Id } from "@/ipc";
import { useApp } from "@/state/store";
import { playStatusSound } from "@/lib/statusSounds";
import { Button } from "@/components/ui/button";
import { RelayMark, RingMark } from "./common";
import { CreateSpaceForm, JoinForm, useSubmit } from "./forms";
import { enableRelay } from "@/lib/relay";
import { WelcomeCrowd } from "./WelcomeCrowd";
import "./welcome.css";

function Signature() {
  const [text, setText] = useState("HALKA");
  const timer = useRef(0);
  useEffect(() => {
    const reset = () => { clearInterval(timer.current); setText("HALKA"); };
    document.addEventListener("visibilitychange", reset);
    return () => { clearInterval(timer.current); document.removeEventListener("visibilitychange", reset); };
  }, []);
  function scramble() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clearInterval(timer.current);
    const frames = ["∩Λ⋮Κ∆", "HΛ∥Κ∆", "HA∟Κ∆", "HALK∆", "HALKA"];
    let i = 0;
    setText(frames[i]);
    timer.current = window.setInterval(() => {
      setText(frames[++i]);
      if (i === frames.length - 1) clearInterval(timer.current);
    }, 48);
  }
  return <span className="welcome-sign" onPointerEnter={scramble}>
    <RingMark size={24} className="text-copper" /><span className="sr-only">Halka</span><span aria-hidden>{text}</span>
  </span>;
}

function PrivacyStatus() {
  const active = useApp((s) => s.snap!.active_relay_only);
  const requested = useApp((s) => s.snap!.settings.relay_only);
  const { busy, error, run } = useSubmit(() => enableRelay(undefined, false));
  const Icon = active ? ShieldCheck : Shield;
  return <div className="welcome-privacy" title="Doğrudan: en hızlısı, üyeler IP adresini görebilir. Relay: bağlantı aktarma sunucusundan geçer, IP adresin gizli kalır.">
    <Icon className={active ? "text-live" : "text-ink-2"} size={17} />
    <div aria-live="polite">
      <div>{active ? "IP eşlerden gizli" : "Doğrudan bağlantıya izin veriliyor"}</div>
      {active !== requested && <small className="text-warn">Yeniden başlatınca uygulanacak</small>}
      {error && <small className="block text-danger">{error}</small>}
    </div>
    {!active && <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => void run()}>{busy ? "Yeniden başlatılıyor…" : "IP’mi gizle"}</Button>}
  </div>;
}

function NameForm({ initial, done, cancel }: { initial: string; done(): void; cancel?: () => void }) {
  const [name, setName] = useState(initial);
  const { busy, error, run } = useSubmit(() => call("set_name", { name: name.trim() }), done);
  return <form className="grid max-w-sm gap-2" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run(); }}>
    <label htmlFor="welcome-name" className="text-sm text-ink-2">Arkadaşların seni nasıl görsün?</label>
    <input id="welcome-name" className="field" autoFocus maxLength={32} placeholder="Adın" value={name} onChange={(e) => setName(e.target.value)} />
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="flex gap-2"><Button disabled={busy || !name.trim()}>{initial ? "Kaydet" : "Devam"} <ArrowRight /></Button>
      {cancel && <Button type="button" variant="ghost" onClick={cancel}>Vazgeç</Button>}</div>
  </form>;
}

export function Onboarding() {
  const { me, spaces } = useApp((s) => s.snap!);
  const lastId = useApp((s) => s.space);
  const sounds = useApp((s) => s.statusSounds);
  const [step, setStep] = useState<"choose" | "name" | "create" | "join">("choose");
  const needsName = !me.name.trim() || me.name === "Anonim";
  const last = spaces.find((space) => space.id === lastId);
  const others = spaces.filter((space) => space !== last);
  const cue = () => { if (useApp.getState().statusSounds) void playStatusSound("join"); };
  function enter(id: Id) {
    cue();
    useApp.getState().select(id);
  }
  return <main className="welcome">
    <div className="welcome-scenery" aria-hidden="true">
      <div className="welcome-orbit" />
      <WelcomeCrowd />
    </div>
    <div className="welcome-scroll">
      <header className="welcome-tools"><PrivacyStatus />
        <Button variant="ghost" size="icon-lg" aria-label="Durum sesleri" title={sounds ? "Durum seslerini kapat" : "Durum seslerini aç"}
          aria-pressed={sounds} onClick={() => useApp.getState().setStatusSounds(!sounds)}>{sounds ? <Volume2 /> : <VolumeX />}</Button>
      </header>
      <section className="welcome-content">
        <Signature />
        <h1>{needsName ? "Halka’ya hoş geldin" : <>Merhaba, <strong>{me.name}</strong>
          <Button className="welcome-edit" variant="ghost" size="icon" aria-label="Adını düzenle" onClick={() => setStep("name")}><Pencil /></Button></>}</h1>
        <div className="welcome-actions enter" key={needsName ? "first" : step}>
          {needsName || step === "name" ? <NameForm initial={needsName ? "" : me.name} done={() => setStep("choose")} cancel={needsName ? undefined : () => setStep("choose")} />
          : step !== "choose" ? <div className="grid max-w-sm gap-3">
            <Button variant="ghost" size="sm" className="w-fit" onClick={() => setStep("choose")}><ArrowLeft /> Geri</Button>
            <h2 className="text-lg font-medium">{step === "create" ? "Halka oluştur" : "Davetle katıl"}</h2>
            {step === "create" ? <CreateSpaceForm autoFocus onDone={cue} /> : <JoinForm autoFocus onDone={cue} />}
          </div> : <>
            {last && <div className="welcome-last">
              <div className="min-w-0"><h2 className="welcome-label">Son halkan</h2><p className="flex items-center gap-2 text-2xl font-medium tracking-tight"><span className="truncate">{last.name}</span>{last.relay_required && <RelayMark />}</p></div>
              <Button size="lg" onClick={() => enter(last.id)}>Devam et <ArrowRight /></Button>
            </div>}
            {others.length > 0 && <div className="welcome-list">
              <h2 className="welcome-label">{last ? "Diğer halkaların" : "Halkaların"}</h2>
              <ul>{others.map((space) => <li key={space.id}><button onClick={() => enter(space.id)}>
                <RingMark size={15} /><span className="truncate">{space.name}</span>{space.relay_required && <RelayMark />}<ChevronRight size={14} className="ml-auto" />
              </button></li>)}</ul>
            </div>}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" variant={spaces.length ? "outline" : "default"} onClick={() => setStep("create")}><Plus /> Halka oluştur</Button>
              <Button size="lg" variant="outline" onClick={() => setStep("join")}><Ticket /> Davetle katıl</Button>
            </div>
          </>}
        </div>
      </section>
    </div>
  </main>;
}
