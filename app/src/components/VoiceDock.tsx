import { HeadphoneOff, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Volume2 } from "lucide-react";
import type { ChannelView, SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has } from "@/lib/space";
import { joinVoice, leaveVoice, shareScreen, toggleDeafen, toggleMute } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { DEAFEN_SHORTCUT, MUTE_SHORTCUT, QUICK_SHARE_SHORTCUT } from "@/lib/shortcutLabels";
import { usesNativeCapture } from "@/media/share";
import { IconBtn } from "./common";

const dockBtn =
  "size-9 rounded-full text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-paper-4/70 hover:text-ink-1 active:scale-95 disabled:opacity-40 [&_svg]:size-[17px]";

/** Floating glass control dock at the foot of the voice stage. */
export function VoiceDock({ space, channel }: { space: SpaceView; channel: ChannelView }) {
  const v = useApp((s) => s.snap!.voice);
  const sharing = useApp((s) => s.nativeShare || !!s.localStream);
  const spatial = useApp((s) => s.snap!.settings.spatial_audio);
  const joined = v?.channel === channel.id;

  if (!joined || !v)
    return (
      <div className="glass enter rounded-full p-1">
        <button
          onClick={() => void joinVoice(space.id, channel.id)}
          disabled={!has(space, "speak")}
          className="flex h-9 items-center gap-2 rounded-full bg-copper px-4 text-[13px] font-medium tracking-tight text-copper-ink transition-[background-color,transform] duration-150 hover:bg-copper-2 active:scale-[0.97] disabled:opacity-40"
        >
          <Volume2 className="size-4" /> {v ? "Bu odaya geç" : "Odaya katıl"}
        </button>
      </div>
    );

  const on = "bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger";
  return (
    <div role="toolbar" aria-label="Ses kontrolleri" className="glass enter flex items-center gap-0.5 rounded-full p-1">
      <IconBtn label={v.muted ? "Mikrofonu aç" : "Mikrofonu kapat"} shortcut={MUTE_SHORTCUT} onClick={toggleMute} aria-pressed={v.muted} className={cn(dockBtn, v.muted && on)}>
        {v.muted ? <MicOff /> : <Mic />}
      </IconBtn>
      <IconBtn
        label={`${v.deafened ? "Sesi aç" : "Sağırlaştır"} · uzamsal ses ${spatial ? "açık" : "kapalı"}`}
        shortcut={DEAFEN_SHORTCUT}
        onClick={toggleDeafen}
        aria-pressed={v.deafened}
        className={cn(dockBtn, v.deafened && on)}
      >
        {v.deafened ? <HeadphoneOff /> : <Headphones />}
      </IconBtn>
      <IconBtn
        label={sharing ? "Paylaşımı durdur" : "Ekranı paylaş"}
        shortcut={usesNativeCapture ? QUICK_SHARE_SHORTCUT : undefined}
        onClick={shareScreen}
        disabled={!has(space, "stream")}
        aria-pressed={sharing}
        className={cn(dockBtn, sharing && "bg-copper-soft text-copper hover:bg-copper-soft hover:text-copper")}
      >
        <MonitorUp />
      </IconBtn>
      <span className="mx-1 h-5 w-px bg-line-2" aria-hidden />
      <IconBtn label="Odadan ayrıl" onClick={leaveVoice} className={cn(dockBtn, "text-danger hover:bg-danger hover:text-on-media")}>
        <PhoneOff />
      </IconBtn>
    </div>
  );
}
