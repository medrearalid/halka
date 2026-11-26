import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HeadphoneOff, Maximize2, MicOff, Minimize2, MonitorUp, Volume2 } from "lucide-react";
import type { ChannelView, Id, MemberView, SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, memberOf } from "@/lib/space";
import { seatAngles } from "@/lib/seats";
import { joinVoice } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { linkLabel } from "@/lib/link";
import { createStreamDecoder, watchStream } from "@/media/watch";
import { previewShare } from "@/media/share";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OrbAvatar } from "./OrbAvatar";
import { MemberMenuContent } from "./MembersPanel";

export function VoiceRoom({ space, channel }: { space: SpaceView; channel: ChannelView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const joined = useApp((s) => s.snap!.voice?.channel === channel.id);
  const watchFullscreen = useApp((s) => s.watchFullscreen);
  const [focus, setFocus] = useState<Id | null>(null);
  const streams = channel.streams;
  const fullscreenMember = joined && watchFullscreen && streams.includes(watchFullscreen) ? watchFullscreen : null;
  const focused = fullscreenMember ?? (focus && streams.includes(focus) ? focus : null);

  useEffect(() => {
    if (!focused) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog]") && setFocus(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focused]);

  // pb-16 keeps the floating VoiceDock (Shell) clear of the lowest seat
  return (
    <div className={cn("voice-stage flex min-h-0 min-w-0 flex-1 flex-col", !fullscreenMember && "pb-16")}>
      {/* One tile instance per stream across focus changes, so the decoder never restarts. */}
      {streams.length > 0 && (
        <div
          className={cn(
            fullscreenMember
              ? "min-h-0 flex-1"
              : focused
              ? "min-h-0 flex-1 p-3 pb-1"
              : cn("grid max-h-[46%] shrink-0 content-start gap-2 overflow-y-auto p-3 pb-0", streams.length === 1 ? "grid-cols-1 justify-items-center" : "mx-auto w-full max-w-[150vh] grid-cols-2"),
          )}
        >
          {streams.map((id) => (
            <div
              key={id}
              className={focused ? (id === focused ? "h-full" : "hidden") : cn("w-full", streams.length === 1 && "max-w-[min(560px,75vh)]")}
            >
              <StreamTile
                space={space}
                member={id}
                joined={joined}
                focused={id === focused}
                watchFullscreen={id === fullscreenMember}
                onToggleFocus={() => {
                  if (!fullscreenMember) setFocus(id === focused ? null : id);
                }}
              />
            </div>
          ))}
        </div>
      )}
      {!fullscreenMember && (focused ? <SeatStrip space={space} channel={channel} meId={meId} joined={joined} /> : <Ring space={space} channel={channel} meId={meId} joined={joined} />)}
    </div>
  );
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function Ring({ space, channel, meId, joined }: { space: SpaceView; channel: ChannelView; meId: Id; joined: boolean }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const seats = useMemo(() => seatAngles(meId, channel.voice), [meId, channel.voice]);
  const n = seats.length;
  const box = Math.min(w, h, 560);
  const orbit = n > 1;
  const avatar = Math.round(orbit
    ? Math.max(32, Math.min(76, box * 0.16, (box * 2) / n))
    : Math.max(42, Math.min(116, box * 0.33)));
  const r = Math.max(0, box / 2 - avatar / 2 - 43);
  const compact = orbit && r < 42;

  return (
    <div ref={ref} className="relative isolate flex min-h-0 flex-1 flex-col justify-center overflow-hidden">
      {box > 0 && (compact ? (
        <SeatStrip space={space} channel={channel} meId={meId} joined={joined} />
      ) : (
        <div className="enter relative mx-auto shrink-0" style={{ width: box, height: box }}>
          {orbit && (
            <div
              aria-hidden
              className="voice-orbit absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ width: r * 2, height: r * 2 }}
            />
          )}
          <div className="absolute inset-0">
            {seats.map((s) => {
              const x = orbit ? -Math.sin(s.theta) * r : 0;
              const y = (orbit ? Math.cos(s.theta) * r : -12) - avatar / 2;
              const m = memberOf(space, s.id);
              const style = { transform: `translate(calc(-50% + ${x.toFixed(1)}px), ${y.toFixed(1)}px)` };
              if (s.id === meId && !joined)
                return (
                  <div key="me-empty" className="seat absolute top-1/2 left-1/2 flex flex-col items-center" style={style}>
                    <button
                      onClick={() => void joinVoice(space.id, channel.id)}
                      disabled={!has(space, "speak")}
                      className="grid place-items-center rounded-full border border-dashed border-line-2 bg-paper-2 text-ink-3 transition-colors duration-150 enabled:hover:border-copper enabled:hover:text-copper"
                      style={{ width: avatar, height: avatar }}
                      aria-label="Sesli odaya katıl"
                    >
                      <Volume2 className="size-[28%]" />
                    </button>
                    <div className="mt-2 text-center text-xs text-ink-3">{orbit ? "Senin yerin" : "Oda boş"}</div>
                  </div>
                );
              if (!m) return null;
              return <Seat key={s.id} space={space} m={m} self={s.id === meId} size={avatar} style={style} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Seat({ space, m, self, size, style }: { space: SpaceView; m: MemberView; self: boolean; size: number; style: CSSProperties }) {
  const meHidden = useApp((s) => s.snap?.active_relay_only ?? false);
  const conn = linkLabel(m, meHidden);
  const v = m.voice;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="seat absolute top-1/2 left-1/2 flex flex-col items-center" style={style}>
          <button
            type="button"
            aria-label={`${m.name} profili`}
            aria-haspopup="dialog"
            className="rounded-full"
            onClick={(e) => useApp.getState().openProfile(m.id, space.id, e.currentTarget)}
          >
            <OrbAvatar id={m.id} name={m.name} size={size} muted={v?.muted} deafened={v?.deafened} live>
              {(v?.muted || v?.deafened) && (
                <span className="absolute -right-1.5 -bottom-1 grid size-[18px] place-items-center rounded-full bg-paper-1 text-danger ring-1 ring-line-2">
                  {v.deafened ? <HeadphoneOff className="size-3" /> : <MicOff className="size-3" />}
                </span>
              )}
              {v?.streaming && (
                <span className="absolute -top-1 -right-1.5 grid size-[18px] place-items-center rounded-full bg-paper-1 text-copper ring-1 ring-line-2">
                  <MonitorUp className="size-3" />
                </span>
              )}
            </OrbAvatar>
          </button>
          <div className="mt-2.5 max-w-[110px] truncate text-center text-xs font-medium tracking-tight">{self ? `${m.name} (sen)` : m.name}</div>
          {conn && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="num flex items-center gap-1 text-[10.5px] text-ink-3">
                  <span className={cn("size-1.5 rounded-full", conn.tone)} />
                  {conn.text}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {conn.detail.map((d) => <div key={d}>{d}</div>)}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </ContextMenuTrigger>
      <MemberMenuContent space={space} m={m} />
    </ContextMenu>
  );
}

function SeatStrip({ space, channel, meId, joined }: { space: SpaceView; channel: ChannelView; meId: Id; joined: boolean }) {
  const seats = seatAngles(meId, channel.voice);
  return (
    <div className="flex shrink-0 items-center justify-center-safe gap-4 overflow-x-auto px-3 py-2">
      {seats.map(({ id }) => {
        if (id === meId && !joined) return null;
        const m = memberOf(space, id);
        return m ? <MiniSeat key={id} m={m} space={space.id} /> : null;
      })}
    </div>
  );
}

function MiniSeat({ m, space }: { m: MemberView; space: Id }) {
  return (
    <button
      type="button"
      aria-label={`${m.name} profili`}
      aria-haspopup="dialog"
      className="flex shrink-0 items-center gap-1.5 rounded-md"
      onClick={(e) => useApp.getState().openProfile(m.id, space, e.currentTarget)}
    >
      <OrbAvatar id={m.id} name={m.name} size={28} muted={m.voice?.muted} deafened={m.voice?.deafened} live mini />
      <span className="text-xs text-ink-2">{m.name}</span>
      {m.voice?.muted && <MicOff className="size-3 text-danger" />}
    </button>
  );
}

function StreamTile({
  space,
  member,
  joined,
  focused,
  watchFullscreen,
  onToggleFocus,
}: {
  space: SpaceView;
  member: Id;
  joined: boolean;
  focused?: boolean;
  watchFullscreen: boolean;
  onToggleFocus: () => void;
}) {
  const meId = useApp((s) => s.snap!.me.id);
  const local = useApp((s) => s.localStream);
  const native = useApp((s) => s.nativeShare);
  const tileRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"connecting" | "live" | "ended" | "error">("connecting");
  const self = member === meId;
  const name = memberOf(space, member)?.name ?? "?";

  useEffect(() => {
    if (!self || !videoRef.current) return;
    videoRef.current.srcObject = local;
    setState(local ? "live" : "connecting");
  }, [self, local]);

  useEffect(() => {
    if (!joined || !canvasRef.current || (self && !native)) return;
    setState("connecting");
    if (self) {
      const decoder = createStreamDecoder(canvasRef.current, {
        onSize: () => setState("live"),
        onError: () => setState("error"),
      });
      const off = previewShare(decoder.onPacket);
      return () => { off?.(); decoder.stop(); };
    }
    const h = watchStream(member, canvasRef.current, {
      onSize: () => setState("live"),
      onError: () => setState("error"),
      onEnded: () => setState("ended"),
    });
    return () => h.stop();
  }, [self, joined, member, self && native]);

  const fullscreen = () => {
    if (watchFullscreen) {
      useApp.setState({ watchFullscreen: null });
      return;
    }
    const el = tileRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      ref={tileRef}
      onClick={onToggleFocus}
      onDoubleClick={(e) => {
        e.stopPropagation();
        fullscreen();
      }}
      className={cn(
        "group relative overflow-hidden bg-paper-0",
        !watchFullscreen && "rounded-lg border border-line",
        focused ? "h-full w-full" : "aspect-video w-full",
      )}
    >
      {self && !native ? (
        <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 size-full object-contain" />
      ) : (
        <canvas ref={canvasRef} className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200", state === "live" ? "opacity-100" : "opacity-0")} />
      )}
      {state !== "live" && (
        <div className="absolute inset-0 grid place-items-center text-xs text-ink-3">
          {!joined && !self
            ? `${name} ekranını paylaşıyor — izlemek için odaya katıl`
            : state === "error"
              ? "Yayın açılamadı"
              : state === "ended"
                ? "Yayın bitti"
                : "Yayına bağlanılıyor…"}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-media-scrim to-transparent px-2.5 pt-6 pb-1.5 text-xs text-on-media">
        <span className="size-1.5 rounded-full bg-live" />
        <span className="font-medium">{self ? "Senin ekranın" : name}</span>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (watchFullscreen) fullscreen();
          else onToggleFocus();
        }}
        aria-label={watchFullscreen ? "Tam ekrandan çık" : focused ? "Küçült" : "Büyüt"}
        className="absolute top-2 right-2 grid size-6 place-items-center rounded-md bg-media-scrim text-on-media opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
      >
        {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
    </div>
  );
}
