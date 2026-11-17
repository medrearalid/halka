import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HeadphoneOff, Headphones, Maximize2, MicOff, Minimize2, MonitorUp, Volume2 } from "lucide-react";
import type { ChannelView, Id, MemberView, SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, memberOf } from "@/lib/space";
import { levelRef } from "@/lib/levels";
import { seatAngles } from "@/lib/seats";
import { joinVoice, shareScreen } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { watchStream } from "@/media/watch";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar } from "./common";
import { MemberMenuContent } from "./MembersPanel";

export function VoiceRoom({ space, channel }: { space: SpaceView; channel: ChannelView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const joined = useApp((s) => s.snap!.voice?.channel === channel.id);
  const spatial = useApp((s) => s.snap!.settings.spatial_audio);
  const [focus, setFocus] = useState<Id | null>(null);
  const streams = channel.streams;
  const focused = focus && streams.includes(focus) ? focus : null;

  useEffect(() => {
    if (!focused) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog]") && setFocus(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focused]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One tile instance per stream across focus changes, so the decoder never restarts. */}
      {streams.length > 0 && (
        <div
          className={cn(
            focused
              ? "min-h-0 flex-1 p-3 pb-1"
              : cn("grid shrink-0 gap-2 p-3 pb-0", streams.length === 1 ? "grid-cols-1 justify-items-center" : "mx-auto w-full max-w-[150vh] grid-cols-2"),
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
                onToggleFocus={() => setFocus(id === focused ? null : id)}
              />
            </div>
          ))}
        </div>
      )}
      {focused ? <SeatStrip space={space} channel={channel} meId={meId} /> : <Ring space={space} channel={channel} meId={meId} joined={joined} />}
      <footer className="flex h-11 shrink-0 items-center gap-3 border-t border-line px-4">
        <Headphones className="size-3.5 shrink-0 text-ink-3" />
        <p className="min-w-0 flex-1 truncate text-xs text-ink-3">
          {spatial
            ? "Halkadaki yerler duyduğun yönle aynı: soldakini solundan, sağdakini sağından duyarsın."
            : "Uzamsal ses kapalı: herkesi tam ortadan duyarsın."}
        </p>
        {joined ? (
          has(space, "stream") && (
            <Button variant="secondary" size="sm" onClick={shareScreen}>
              <MonitorUp /> {streams.includes(meId) ? "Paylaşımı durdur" : "Ekranı paylaş"}
            </Button>
          )
        ) : (
          <Button size="sm" onClick={() => void joinVoice(space.id, channel.id)} disabled={!has(space, "speak")}>
            <Volume2 /> Sesli odaya katıl
          </Button>
        )}
      </footer>
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
  const box = Math.max(0, Math.min(w, h) - 24);
  const avatar = Math.round(Math.max(36, Math.min(64, box * 0.12, (box * 2.4) / n)));
  const r = Math.max(0, box / 2 - avatar * 0.75 - 18);
  const c = 2 * Math.PI * r;
  const arc = Math.min(0.1, 0.45 / n) * c;

  return (
    <div ref={ref} className="relative min-h-[260px] flex-1 overflow-hidden">
      {box > 0 && (
        <div className="enter absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: box, height: box }}>
          <svg className="absolute inset-0" width={box} height={box} aria-hidden>
            <circle cx={box / 2} cy={box / 2} r={r} fill="none" stroke="var(--ring-line)" strokeWidth="1" />
            <circle cx={box / 2} cy={box / 2} r={r - 10} fill="none" stroke="var(--ring-line)" strokeWidth="1" strokeDasharray="1 7" opacity="0.7" />
            {seats.map((s) =>
              s.id === meId && !joined ? null : (
                <SpeakArc key={s.id} id={s.id} cx={box / 2} cy={box / 2} r={r} arc={arc} c={c} theta={s.theta} />
              ),
            )}
          </svg>
          <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center">
            <span className="text-[15px] font-semibold tracking-tight">{channel.name}</span>
            <span className="num text-xs text-ink-3">
              {channel.voice.length === 0 ? "Oda boş" : `${channel.voice.length} kişi`}
            </span>
          </div>
          {seats.map((s) => {
            const x = -Math.sin(s.theta) * r;
            const y = Math.cos(s.theta) * r;
            const m = memberOf(space, s.id);
            const style = { transform: `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px))` };
            if (s.id === meId && !joined)
              return (
                <div key="me-empty" className="seat absolute top-1/2 left-1/2" style={style}>
                  <button
                    onClick={() => void joinVoice(space.id, channel.id)}
                    disabled={!has(space, "speak")}
                    className="grid place-items-center rounded-full border border-dashed border-line-2 text-ink-3 transition-colors duration-150 hover:border-copper hover:text-copper"
                    style={{ width: avatar, height: avatar }}
                    aria-label="Sesli odaya katıl"
                  >
                    <Volume2 className="size-4" />
                  </button>
                  <div className="mt-1.5 text-center text-xs text-ink-3">Senin yerin</div>
                </div>
              );
            if (!m) return null;
            return <Seat key={s.id} space={space} m={m} self={s.id === meId} size={avatar} style={style} />;
          })}
        </div>
      )}
    </div>
  );
}

function SpeakArc({ id, cx, cy, r, arc, c, theta }: { id: Id; cx: number; cy: number; r: number; arc: number; c: number; theta: number }) {
  const lvl = useMemo(() => levelRef(id), [id]);
  // SVG circles start at 3 o'clock and run clockwise on screen; seat θ is measured from 6 o'clock.
  const deg = 90 + (theta * 180) / Math.PI - (arc / c) * 180;
  return (
    <circle
      ref={lvl as never}
      cx={cx}
      cy={cy}
      r={r}
      fill="none"
      stroke="var(--copper)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={`${arc} ${c}`}
      transform={`rotate(${deg} ${cx} ${cy})`}
      style={{ opacity: "calc(var(--lvl) * 1.4)" }}
    />
  );
}

function connLabel(m: MemberView) {
  if (m.conn === "self") return null;
  if (m.conn === "none") return { text: "bağlantı yok", tone: "bg-ink-3" };
  const rtt = m.rtt_ms;
  const tone = rtt === null ? "bg-ink-3" : rtt < 80 ? "bg-live" : rtt < 180 ? "bg-warn" : "bg-danger";
  return { text: `${m.conn === "direct" ? "doğrudan" : "relay"}${rtt !== null ? ` · ${rtt} ms` : ""}`, tone };
}

function Seat({ space, m, self, size, style }: { space: SpaceView; m: MemberView; self: boolean; size: number; style: CSSProperties }) {
  const lvl = useMemo(() => levelRef(m.id), [m.id]);
  const conn = connLabel(m);
  const v = m.voice;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="seat absolute top-1/2 left-1/2 flex flex-col items-center" style={style}>
          <div ref={lvl} className="relative" style={{ width: size, height: size }}>
            <span
              className="pointer-events-none absolute -inset-[5px] rounded-full border-2 border-copper will-change-transform"
              style={{ opacity: "min(1, calc(var(--lvl) * 2.2))", transform: "scale(calc(1 + var(--lvl) * 0.16))" }}
            />
            <Avatar id={m.id} name={m.name} size={size} className={cn(v?.deafened && "opacity-60")} />
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
          </div>
          <div className="mt-1.5 max-w-[110px] truncate text-center text-xs font-medium tracking-tight">{self ? `${m.name} (sen)` : m.name}</div>
          {conn && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="num flex items-center gap-1 text-[10.5px] text-ink-3">
                  <span className={cn("size-1.5 rounded-full", conn.tone)} />
                  {conn.text}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {m.conn === "direct" ? "Doğrudan eşler arası bağlantı" : m.conn === "relay" ? "Relay üzerinden — IP adresleri gizli" : "Şu an ulaşılamıyor"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </ContextMenuTrigger>
      <MemberMenuContent space={space} m={m} />
    </ContextMenu>
  );
}

function SeatStrip({ space, channel, meId }: { space: SpaceView; channel: ChannelView; meId: Id }) {
  const seats = seatAngles(meId, channel.voice);
  return (
    <div className="flex shrink-0 items-center justify-center gap-4 py-1">
      {seats.map(({ id }) => {
        const m = memberOf(space, id);
        return m ? <MiniSeat key={id} m={m} /> : null;
      })}
    </div>
  );
}

function MiniSeat({ m }: { m: MemberView }) {
  const lvl = useMemo(() => levelRef(m.id), [m.id]);
  return (
    <div className="flex items-center gap-1.5">
      <div ref={lvl} className="relative size-7">
        <span className="absolute -inset-[3px] rounded-full border-[1.5px] border-copper" style={{ opacity: "min(1, calc(var(--lvl) * 2.2))" }} />
        <Avatar id={m.id} name={m.name} size={28} />
      </div>
      <span className="text-xs text-ink-2">{m.name}</span>
      {m.voice?.muted && <MicOff className="size-3 text-danger" />}
    </div>
  );
}

function StreamTile({
  space,
  member,
  joined,
  focused,
  onToggleFocus,
}: {
  space: SpaceView;
  member: Id;
  joined: boolean;
  focused?: boolean;
  onToggleFocus: () => void;
}) {
  const meId = useApp((s) => s.snap!.me.id);
  const local = useApp((s) => s.localStream);
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
    if (self || !joined || !canvasRef.current) return;
    setState("connecting");
    const h = watchStream(member, canvasRef.current, {
      onSize: () => setState("live"),
      onError: () => setState("error"),
      onEnded: () => setState("ended"),
    });
    return () => h.stop();
  }, [self, joined, member]);

  const fullscreen = () => {
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
        "group relative overflow-hidden rounded-lg border border-line bg-paper-0",
        focused ? "h-full w-full" : "aspect-video w-full",
      )}
    >
      {self ? (
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
          onToggleFocus();
        }}
        aria-label={focused ? "Küçült" : "Büyüt"}
        className="absolute top-2 right-2 grid size-6 place-items-center rounded-md bg-media-scrim text-on-media opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
      >
        {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
    </div>
  );
}
