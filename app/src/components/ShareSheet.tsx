import { useEffect, useState } from "react";
import { AppWindow, Gauge, Monitor } from "lucide-react";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRESETS, startShare, type SharePreset, type ShareSurface } from "@/media/share";
import { pickEncoderConfig } from "@/media/codec";

const KEY = "halka.share";

function load(): { surface: ShareSurface; preset: SharePreset } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "");
    if ((v.surface === "monitor" || v.surface === "window") && v.preset in PRESETS) return v;
  } catch {
    /* first use or storage unavailable */
  }
  return { surface: "monitor", preset: "balanced" };
}

const SURFACES: { id: ShareSurface; icon: typeof Monitor; title: string; body: string }[] = [
  { id: "monitor", icon: Monitor, title: "Tüm ekran", body: "Oyunlar ve tam ekran uygulamalar" },
  { id: "window", icon: AppWindow, title: "Tek pencere", body: "Yalnızca seçtiğin uygulama görünür" },
];

/** Pre-share sheet: what and how to share. The system picker then opens on the matching tab. */
export function ShareSheet({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState(load);
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
  useEffect(() => void pickEncoderConfig(Math.round((p.height * 16) / 9), p.height, p.fps, p.bitrate).catch(() => {}), [p]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="pr-6">
        <DialogTitle className="text-[14px] font-semibold tracking-tight">Ekranını paylaş</DialogTitle>
        <DialogDescription className="mt-1 text-xs text-ink-3">Odadakiler yayınına tek tıkla katılır. Görüntü doğrudan onlara gider.</DialogDescription>
      </div>

      <div role="radiogroup" aria-label="Ne paylaşılacak" className="grid grid-cols-2 gap-2">
        {SURFACES.map(({ id, icon: Icon, title, body }) => (
          <button
            key={id}
            role="radio"
            aria-checked={choice.surface === id}
            onClick={() => set({ surface: id })}
            className="group flex flex-col items-start gap-2.5 rounded-lg border border-line-2 bg-paper-0 p-3 text-left transition-colors duration-150 hover:border-ink-3/40 aria-checked:border-copper/60 aria-checked:bg-copper-soft"
          >
            <span className="relative grid h-14 w-full place-items-center overflow-hidden rounded-md border border-line bg-paper-2">
              <Icon className="size-6 text-ink-3 transition-colors group-aria-checked:text-copper" strokeWidth={1.5} />
            </span>
            <span>
              <span className="block text-[13px] font-medium tracking-tight">{title}</span>
              <span className="block text-xs text-ink-3">{body}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-ink-2">Kalite</span>
          <span className="num flex items-center gap-1 text-ink-3">
            <Gauge className="size-3" /> en fazla {(p.bitrate / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mbps
          </span>
        </div>
        <div role="radiogroup" aria-label="Kalite" className="grid grid-cols-3 gap-1 rounded-md border border-line-2 bg-paper-0 p-0.5">
          {(Object.keys(PRESETS) as SharePreset[]).map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={choice.preset === k}
              onClick={() => set({ preset: k })}
              className="flex flex-col items-center rounded-[4px] py-1.5 text-ink-2 transition-colors duration-150 hover:text-ink-1 aria-checked:bg-paper-3 aria-checked:text-ink-1"
            >
              <span className="text-xs font-medium">{PRESETS[k].label}</span>
              <span className="num text-2xs text-ink-3">{PRESETS[k].detail}</span>
            </button>
          ))}
        </div>
        <p className="text-2xs text-ink-3">Bağlantı yoğunlaşırsa kalite kendiliğinden düşer, böylece oyun içi ping etkilenmez.</p>
      </div>

      <div className={cn("flex items-center justify-between gap-3 border-t border-line pt-3")}>
        <span className="text-2xs text-ink-3">Sonraki adımda Windows hangi {choice.surface === "monitor" ? "ekranı" : "pencereyi"} paylaşacağını soracak.</span>
        <Button
          onClick={() => {
            onDone();
            void startShare(choice);
          }}
        >
          Paylaşmaya başla
        </Button>
      </div>
    </div>
  );
}
