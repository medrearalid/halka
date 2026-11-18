import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Keyboard, Mic, ShieldCheck, User, X } from "lucide-react";
import { call, type AudioDevices, type Settings } from "@/ipc";
import { useApp } from "@/state/store";
import { levelRef } from "@/lib/levels";
import { fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { DEAFEN_SHORTCUT, MUTE_SHORTCUT, QUICK_SHARE_SHORTCUT, WATCH_FULLSCREEN_SHORTCUT } from "@/lib/shortcutLabels";
import { usesNativeCapture } from "@/media/share";
import { enableRelay } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, ConnExplainer, Field, Kbd } from "./common";
import { Group, PaneTitle, Row, SettingsLayout, type Tab } from "./SettingsLayout";
import { AppVersion } from "./UpdatePill";

type TabId = "profile" | "audio" | "shortcuts" | "privacy";
const TABS: Tab<TabId>[] = [
  { id: "profile", label: "Profil", icon: <User /> },
  { id: "audio", label: "Ses ve görüntü", icon: <Mic /> },
  { id: "shortcuts", label: "Kısayollar", icon: <Keyboard /> },
  { id: "privacy", label: "Gizlilik ve ağ", icon: <ShieldCheck /> },
];

function saveSettings(p: Partial<Settings>) {
  const cur = useApp.getState().snap?.settings;
  if (!cur) return;
  const next = { ...cur, ...p };
  // optimistic: reflect immediately, the next snapshot confirms
  useApp.setState((s) => (s.snap ? { snap: { ...s.snap, settings: next } } : {}));
  void call("set_settings", { settings: next }).catch(fail);
}

export function keyLabel(code: string) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = { Space: "Boşluk", ShiftLeft: "Sol Shift", ShiftRight: "Sağ Shift", ControlLeft: "Sol Ctrl", AltLeft: "Sol Alt", CapsLock: "Caps Lock", Backquote: "`", Tab: "Tab" };
  return map[code] ?? code;
}

export function AppSettings() {
  const [tab, setTab] = useState<TabId>("profile");
  return (
    <SettingsLayout title="Uygulama ayarları" subtitle="Bu cihaz için" tabs={TABS} tab={tab} setTab={setTab}>
      {tab === "profile" && <Profile />}
      {tab === "audio" && <Audio />}
      {tab === "shortcuts" && <Shortcuts />}
      {tab === "privacy" && <Privacy />}
    </SettingsLayout>
  );
}

function Shortcuts() {
  const fullScreen = useApp((s) => s.snap!.settings.quick_share_full_screen);
  return (
    <>
      <PaneTitle title="Kısayollar" />
      <Group>
        <Row label="Mikrofonu aç/kapat"><Kbd>{MUTE_SHORTCUT}</Kbd></Row>
        <Row label="Sağırlaştırmayı aç/kapat"><Kbd>{DEAFEN_SHORTCUT}</Kbd></Row>
        {usesNativeCapture && (
          <>
            <Row label="Hızlı ekran paylaşımı" desc="Yayını başlatır veya durdurur. Halka arka plandayken de çalışır.">
              <Kbd>{QUICK_SHARE_SHORTCUT}</Kbd>
            </Row>
            <Row label="Tüm ekranı paylaş" desc="Kapalıyken öndeki pencere, açıkken o pencerenin bulunduğu ekran paylaşılır.">
              <Switch checked={fullScreen} onCheckedChange={(value) => saveSettings({ quick_share_full_screen: value })} aria-label="Hızlı paylaşımda tüm ekranı paylaş" />
            </Row>
            <Row label="Yayını tam ekran izle" desc="Ses odandaki yayını öne getirir. Aynı tuşlarla veya Esc ile önceki pencereye dönersin.">
              <Kbd>{WATCH_FULLSCREEN_SHORTCUT}</Kbd>
            </Row>
          </>
        )}
      </Group>
    </>
  );
}

function Profile() {
  const me = useApp((s) => s.snap!.me);
  return (
    <>
      <PaneTitle title="Profil" />
      <Group>
        <div className="flex items-center gap-3 py-3">
          <Avatar id={me.id} name={me.name} size={40} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{me.name}</span>
          <Button variant="secondary" onClick={(e) => useApp.getState().openProfile(me.id, undefined, e.currentTarget)}>
            <User /> Profili aç
          </Button>
        </div>
      </Group>
      <AppVersion />
    </>
  );
}

function DevicePicker({ label, value, options, onChange }: { label: string; value: string | null; options: string[]; onChange: (v: string | null) => void }) {
  return (
    <Field label={label}>
      <DropdownMenu>
        <DropdownMenuTrigger className="field flex items-center gap-2 text-left data-[state=open]:border-copper">
          <span className="min-w-0 flex-1 truncate">{value ?? "Sistem varsayılanı"}</span>
          <ChevronsUpDown className="size-3.5 text-ink-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {[null, ...options].map((o) => (
            <DropdownMenuItem key={o ?? "_default"} onSelect={() => onChange(o)}>
              <span className="min-w-0 flex-1 truncate">{o ?? "Sistem varsayılanı"}</span>
              {o === value && <Check className="text-copper" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}

function Audio() {
  const settings = useApp((s) => s.snap!.settings);
  const statusSounds = useApp((s) => s.statusSounds);
  const meId = useApp((s) => s.snap!.me.id);
  const inVoice = useApp((s) => !!s.snap!.voice);
  const [dev, setDev] = useState<AudioDevices | null>(null);
  const [vad, setVad] = useState(settings.vad_threshold);
  const [capturing, setCapturing] = useState(false);
  const meter = useMemo(() => levelRef(meId), [meId]);

  useEffect(() => {
    call("audio_devices").then(setDev, fail);
  }, []);
  useEffect(() => setVad(settings.vad_threshold), [settings.vad_threshold]);

  // Outside a room, run a local mic test so the threshold meter is live.
  useEffect(() => {
    if (inVoice) return;
    call("mic_test", { on: true }).catch(() => {});
    return () => void call("mic_test", { on: false }).catch(() => {});
  }, [inVoice]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") saveSettings({ ptt_key: e.code });
      setCapturing(false);
    };
    // mouse side buttons are popular PTT keys; the core polls them globally
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      saveSettings({ ptt_key: e.button === 3 ? "Mouse4" : "Mouse5" });
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("mousedown", onMouse, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("mousedown", onMouse, { capture: true });
    };
  }, [capturing]);

  const setDevices = (input: string | null, output: string | null) => {
    setDev((d) => (d ? { ...d, input, output } : d));
    void call("set_audio_devices", { input, output }).catch(fail);
  };

  return (
    <>
      <PaneTitle title="Ses ve görüntü" />
      <Group title="Aygıtlar">
        <div className="grid grid-cols-2 gap-3 py-3 max-[700px]:grid-cols-1">
          {dev ? (
            <>
              <DevicePicker label="Mikrofon" value={dev.input} options={dev.inputs} onChange={(v) => setDevices(v, dev.output)} />
              <DevicePicker label="Hoparlör / kulaklık" value={dev.output} options={dev.outputs} onChange={(v) => setDevices(dev.input, v)} />
            </>
          ) : (
            [0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <div className="flex h-4 items-center"><div className="skeleton h-3 w-20" /></div>
                <div className="skeleton h-[30px]" />
              </div>
            ))
          )}
        </div>
      </Group>
      <Group title="Ses efektleri">
        <Row label="Durum sesleri" desc="Bağlantı, ses odası ve susturma değişikliklerinde kısa bir ses çal.">
          <Switch checked={statusSounds} onCheckedChange={useApp.getState().setStatusSounds} aria-label="Durum sesleri" />
        </Row>
      </Group>
      <Group title="İşleme">
        <Row label="Akıllı gürültü engelleme" desc="Yapay zekâ (RNNoise) yalnızca konuşmayı geçirir; klavye, fare ve fan sesi gönderilmez.">
          <Switch checked={settings.noise_suppression} onCheckedChange={(v) => saveSettings({ noise_suppression: v })} aria-label="Gürültü bastırma" />
        </Row>
        <Row label="Uzamsal ses" desc="Odadakileri çemberde oturdukları yönden duyarsın: soldakini solundan, sağdakini sağından.">
          <Switch checked={settings.spatial_audio} onCheckedChange={(v) => saveSettings({ spatial_audio: v })} aria-label="Uzamsal ses" />
        </Row>
        <Row label="Yankı engelleme" desc="Hoparlör kullanıyorsan açık tut.">
          <Switch checked={settings.echo_cancellation} onCheckedChange={(v) => saveSettings({ echo_cancellation: v })} aria-label="Yankı engelleme" />
        </Row>
      </Group>
      <Group title="Giriş modu">
        <Row label="Bas-konuş" desc="Yalnızca tuşa basılıyken iletilir. Pencere odaktayken çalışır.">
          <Switch checked={settings.push_to_talk} onCheckedChange={(v) => saveSettings({ push_to_talk: v })} aria-label="Bas-konuş" />
        </Row>
        {settings.push_to_talk && (
          <Row label="Bas-konuş tuşu">
            <Button
              variant="outline"
              size="sm"
              data-key-capture={capturing ? "" : undefined}
              onClick={() => setCapturing(true)}
              className={cn("min-w-[120px] font-mono", capturing && "border-copper text-copper")}
            >
              {capturing ? "Bir tuşa bas…" : keyLabel(settings.ptt_key)}
            </Button>
          </Row>
        )}
        <div className={cn("py-3", settings.push_to_talk && "opacity-50")}>
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span>Konuşma algılama eşiği</span>
            <span className="num text-xs text-ink-3">{Math.round(vad * 100)}%</span>
          </div>
          <div ref={meter} className="relative mb-2 h-2 overflow-hidden rounded-full bg-paper-4">
            <div className="absolute inset-y-0 left-0 w-full origin-left bg-ink-3 will-change-transform" style={{ transform: "scaleX(var(--lvl))" }} />
            <div
              className="absolute inset-y-0 left-0 w-full origin-left bg-live will-change-transform"
              style={{ transform: "scaleX(var(--lvl))", clipPath: `inset(0 0 0 ${vad * 100}%)` }}
            />
            <div className="absolute inset-y-0 w-px bg-ink-1" style={{ left: `${vad * 100}%` }} />
          </div>
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={[vad]}
            disabled={settings.push_to_talk}
            onValueChange={([v]) => setVad(v)}
            onValueCommit={([v]) => saveSettings({ vad_threshold: v })}
            aria-label="Konuşma algılama eşiği"
          />
          <p className="mt-2 text-2xs text-ink-3">
            {inVoice ? "Yeşil kısım eşiği geçen sesin; çizginin sağında kalınca iletilir." : "Canlı seviyeyi görmek için bir ses odasına katıl."}
          </p>
        </div>
      </Group>
    </>
  );
}

function Privacy() {
  const settings = useApp((s) => s.snap!.settings);
  const active = useApp((s) => s.snap!.active_relay_only);
  const [url, setUrl] = useState("");
  const valid = /^https?:\/\/[^\s]+$/i.test(url.trim()) && !settings.relays.includes(url.trim());
  return (
    <>
      <PaneTitle title="Gizlilik ve ağ" />
      <Group>
        <Row
          label="IP adresimi gizle (yalnızca relay)"
          desc={
            <>
              {active ? "IP adresin gizli." : "Şu an doğrudan bağlanıyorsun."}{" "}
              {active !== settings.relay_only ? <span className="text-warn">Bir sonraki açılışta doğrudan bağlantıya döner.</span> : active ? "Kapatırsan bir sonraki açılışta geçerli olur." : "Açınca uygulama hemen yeniden başlar."}
            </>
          }
        >
          {/* turning on restarts right away and resumes; turning off waits for the next launch */}
          <Switch checked={settings.relay_only} onCheckedChange={(v) => (v && !active ? void enableRelay().catch(fail) : saveSettings({ relay_only: v }))} aria-label="Yalnızca relay" />
        </Row>
        <ConnExplainer className="border-b border-line py-2.5" />
      </Group>
      <Group title="Özel relay’ler">
        <div className="py-3">
          <p className="mb-3 text-xs text-ink-3">
            Boş bırakırsan yerleşik herkese açık relay’ler kullanılır. <span className="text-warn">Değişiklikler yeniden başlatınca geçerli olur.</span>
          </p>
          {settings.relays.length > 0 && (
            <ul className="mb-3 rounded-md border border-line">
              {settings.relays.map((r) => (
                <li key={r} className="flex h-8 items-center gap-2 border-b border-line pr-1 pl-2.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" data-selectable>
                    {r}
                  </span>
                  <button aria-label="Kaldır" onClick={() => saveSettings({ relays: settings.relays.filter((x) => x !== r) })} className="grid size-6 place-items-center rounded text-ink-3 hover:bg-paper-3 hover:text-danger">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              saveSettings({ relays: [...settings.relays, url.trim()] });
              setUrl("");
            }}
          >
            <input className="field font-mono text-xs" placeholder="https://relay.ornek.net" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Relay adresi" />
            <Button type="submit" variant="secondary" disabled={!valid}>
              Ekle
            </Button>
          </form>
        </div>
      </Group>
    </>
  );
}
