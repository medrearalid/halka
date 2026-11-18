import { useEffect, useState } from "react";
import { AppWindow, Gauge, LoaderCircle, Monitor } from "lucide-react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { call, errText, type CaptureSource } from "@/ipc";
import { cancelShareStart, PRESETS, startShare, usesNativeCapture, type SharePreset, type ShareSurface } from "@/media/share";
import { pickEncoderConfig } from "@/media/codec";

const KEY = "halka.share";

function load(): { surface: ShareSurface; preset: SharePreset } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "");
    if ((v.surface === "monitor" || v.surface === "window") && Object.hasOwn(PRESETS, v.preset)) return v;
  } catch {
    /* first use or storage unavailable */
  }
  return { surface: "monitor", preset: "balanced" };
}

const SURFACES: { id: ShareSurface; icon: typeof Monitor; title: string; body: string }[] = [
  { id: "monitor", icon: Monitor, title: "Tüm ekran", body: "Oyunlar ve tam ekran uygulamalar" },
  { id: "window", icon: AppWindow, title: "Tek pencere", body: "Yalnızca seçtiğin uygulama görünür" },
];

export function ShareSheet({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState(load);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [source, setSource] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(usesNativeCapture);
  const [loadError, setLoadError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const visible = sources.filter((item) => item.kind === choice.surface);
  const selected = visible.find((item) => item.id === source);

  useEffect(() => cancelShareStart, []);
  useEffect(() => {
    if (!usesNativeCapture) return;
    let mounted = true;
    void call("capture_sources").then((items) => {
      if (mounted) setSources(items);
    }).catch((error) => {
      if (mounted) setLoadError(errText(error));
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [reload]);

  const set = (c: Partial<typeof choice>) => {
    const next = { ...choice, ...c };
    setChoice(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* remembered choice is optional */
    }
  };
  const p = PRESETS[choice.preset];
  // warm the hardware encoder while the user decides, so starting the share doesn't hitch
  useEffect(() => {
    if (!usesNativeCapture && p.height) {
      void pickEncoderConfig(Math.round((p.height * 16) / 9), p.height, p.fps, p.bitrate).catch(() => {});
    }
  }, [p]);

  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-4">
      <div className="pr-6">
        <DialogTitle className="text-[14px] font-semibold tracking-tight">Ekranını paylaş</DialogTitle>
        <DialogDescription className="mt-1 text-xs text-ink-3">Paylaşacağın ekranı veya pencereyi ve yayın kalitesini seç.</DialogDescription>
      </div>

      <div role="radiogroup" aria-label="Ne paylaşılacak" className="grid grid-cols-2 gap-2">
        {SURFACES.map(({ id, icon: Icon, title, body }) => (
          <button
            key={id}
            role="radio"
            aria-checked={choice.surface === id}
            disabled={starting}
            onClick={() => { set({ surface: id }); setError(undefined); }}
            className="group flex items-center gap-2 rounded-lg border border-line-2 bg-paper-0 p-2.5 text-left transition-colors duration-150 hover:border-ink-3/40 aria-checked:border-copper/60 aria-checked:bg-copper-soft"
          >
            <Icon className="size-4 shrink-0 text-ink-3 transition-colors group-aria-checked:text-copper" strokeWidth={1.5} />
            <span>
              <span className="block text-[13px] font-medium tracking-tight">{usesNativeCapture ? id === "monitor" ? "Ekranlar" : "Pencereler" : title}</span>
              {!usesNativeCapture && <span className="block text-xs text-ink-3">{body}</span>}
            </span>
          </button>
        ))}
      </div>

      {usesNativeCapture && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink-2">Kaynak</span>
            <Button size="sm" variant="ghost" disabled={loading || starting} onClick={() => {
              setLoadError(undefined);
              setError(undefined);
              setLoading(true);
              setReload((value) => value + 1);
            }}>Yenile</Button>
          </div>
          {loading || loadError || visible.length === 0 ? (
            <p className="rounded-md border border-line bg-paper-0 px-3 py-4 text-xs text-ink-3" role="status">
              {loading ? "Kaynaklar yükleniyor…" : loadError ?? (choice.surface === "monitor" ? "Paylaşılabilir ekran bulunamadı." : "Paylaşılabilir açık pencere bulunamadı.")}
            </p>
          ) : (
            <div role="radiogroup" aria-label="Paylaşılacak kaynak" className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto p-0.5">
              {visible.map((item) => {
                const Icon = item.kind === "monitor" ? Monitor : AppWindow;
                return (
                  <button key={item.id} role="radio" aria-checked={selected?.id === item.id} disabled={starting}
                    title={item.title}
                    className="flex min-w-0 items-center gap-2 rounded-md border border-line-2 bg-paper-0 p-2.5 text-left hover:border-ink-3/40 aria-checked:border-copper/60 aria-checked:bg-copper-soft"
                    onClick={() => { setSource(item.id); setError(undefined); }}>
                    <Icon className="size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{item.title}</span>
                      {!!item.width && <span className="num block text-2xs text-ink-3">{item.width} × {item.height} · {item.fps} Hz</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-2">Kalite</span>
          {!!p.bitrate && (
            <span className="num flex items-center gap-1 text-ink-3">
              <Gauge className="size-3" /> en fazla {(p.bitrate / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mbps
            </span>
          )}
        </div>
        <div role="radiogroup" aria-label="Kalite" className="grid grid-cols-4 gap-1 rounded-md border border-line-2 bg-paper-0 p-0.5">
          {(Object.keys(PRESETS) as SharePreset[]).map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={choice.preset === k}
              disabled={starting}
              onClick={() => set({ preset: k })}
              className="flex flex-col items-center rounded-[4px] py-1.5 text-ink-2 transition-colors duration-150 hover:text-ink-1 aria-checked:bg-paper-3 aria-checked:text-ink-1"
            >
              <span className="text-xs font-medium">{PRESETS[k].label}</span>
              <span className="num text-2xs text-ink-3">{PRESETS[k].detail}</span>
            </button>
          ))}
        </div>
        {choice.preset === "maximum" && <p className="text-2xs text-ink-3">Kaynağın çözünürlüğü ve yenileme hızı hedeflenir. Cihaz ve bağlantıya göre kalite ayarlanır.</p>}
      </div>

      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
        <Button variant="secondary" onClick={() => { cancelShareStart(); onDone(); }}>İptal</Button>
        <Button
          disabled={starting || (usesNativeCapture && (loading || !!loadError || !selected))}
          aria-busy={starting}
          onClick={async () => {
            setStarting(true);
            setError(undefined);
            try {
              if (await startShare({ ...choice, source: selected?.id })) onDone();
            } catch (error) {
              setError(errText(error));
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {starting ? "Başlatılıyor…" : "Paylaşmaya başla"}
        </Button>
      </div>
    </div>
  );
}
