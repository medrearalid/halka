import { useMemo, type CSSProperties } from "react";
import {
  Check,
  ChevronsUpDown,
  Hash,
  House,
  Lock,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  Search,
  Settings,
  Settings2,
  Ticket,
  Volume2,
} from "lucide-react";
import type { ChannelView, SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, memberOf, useSpace } from "@/lib/space";
import { hueOf, initials } from "@/lib/avatar";
import { levelRef } from "@/lib/levels";
import { joinVoice, leaveVoice, toggleMute } from "@/lib/actions";
import { MUTE_SHORTCUT } from "@/lib/shortcutLabels";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, IconBtn, Kbd, RelayMark, SectionLabel } from "./common";

export function Sidebar() {
  const space = useSpace();
  const inVoice = useApp((s) => !!s.snap?.voice);
  return (
    <aside className="flex min-h-0 w-[220px] shrink-0 flex-col border-r border-line bg-paper-0">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconBtn label="Karşılama ekranına dön" side="bottom" onClick={() => useApp.setState({ welcome: true })}>
          <House />
        </IconBtn>
        <SpaceSwitcher space={space} />
      </div>
      <button
        onClick={() => useApp.getState().setPalette(true)}
        className="mx-2 mt-2 flex h-7 items-center gap-2 rounded-md border border-line bg-paper-1 px-2 text-xs text-ink-3 transition-colors duration-150 hover:border-line-2 hover:text-ink-2"
      >
        <Search className="size-3.5" />
        <span className="flex-1 truncate text-left">Ara ya da atla</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      {space ? <ChannelList space={space} /> : <div className="flex-1" />}
      {inVoice && <VoiceStatus />}
      <UserBar />
    </aside>
  );
}

function SpaceGlyph({ space, size = 20 }: { space: { id: string; name: string }; size?: number }) {
  return (
    <span
      className="space-glyph grid shrink-0 place-items-center rounded-full text-[9px] font-bold"
      style={{ width: size, height: size, "--h": hueOf(space.id) } as CSSProperties}
      aria-hidden
    >
      {initials(space.name).slice(0, 1)}
    </span>
  );
}

function SpaceSwitcher({ space }: { space: SpaceView | null }) {
  const spaces = useApp((s) => s.snap!.spaces);
  const { select, openDialog } = useApp.getState();
  const canSettings = !!space && (has(space, "manage_space") || has(space, "manage_channels") || has(space, "manage_roles") || has(space, "invite") || has(space, "ban"));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-paper-2 focus-visible:bg-paper-2 data-[state=open]:bg-paper-2">
        {space && <SpaceGlyph space={space} />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">{space?.name ?? "Halka seç"}</span>
        {space?.relay_required && <RelayMark />}
        <ChevronsUpDown className="size-3.5 text-ink-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="w-[248px]">
        <DropdownMenuLabel className="text-2xs font-medium tracking-wide text-ink-3 uppercase">Halkaların</DropdownMenuLabel>
        {spaces.map((s) => {
          const unread = s.channels.reduce((n, c) => n + c.unread, 0);
          return (
            <DropdownMenuItem key={s.id} onSelect={() => select(s.id)} className="gap-2">
              <SpaceGlyph space={s} size={18} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              {s.relay_required && <RelayMark />}
              {unread > 0 && <span className="num text-2xs text-ink-3">{unread}</span>}
              {s.id === space?.id && <Check className="size-3.5 text-copper" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openDialog("create-space")}>
          <Plus /> Yeni halka
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog("join-space")}>
          <Ticket /> Davetle katıl
        </DropdownMenuItem>
        {space && (
          <>
            <DropdownMenuSeparator />
            {has(space, "invite") && (
              <DropdownMenuItem onSelect={() => openDialog("invite")}>
                <Plus /> Davet et
              </DropdownMenuItem>
            )}
            {canSettings && (
              <DropdownMenuItem onSelect={() => openDialog("space-settings")}>
                <Settings2 /> Halka ayarları
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => openDialog("space-settings", "leave")}
            >
              <LogOut /> Halkadan ayrıl
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChannelList({ space }: { space: SpaceView }) {
  const active = useApp((s) => s.channel);
  const voiceCh = useApp((s) => s.snap?.voice?.channel);
  const { select, openDialog } = useApp.getState();
  const text = space.channels.filter((c) => c.kind === "text");
  const voice = space.channels.filter((c) => c.kind === "voice");
  const add = has(space, "manage_channels") ? (
    <button
      aria-label="Kanal oluştur"
      onClick={() => openDialog("create-channel")}
      className="grid size-5 place-items-center rounded text-ink-3 opacity-0 transition-opacity group-hover/sec:opacity-100 hover:bg-paper-3 hover:text-ink-1 focus-visible:opacity-100"
    >
      <Plus className="size-3.5" />
    </button>
  ) : null;

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2" aria-label="Kanallar">
      <SectionLabel action={add}>Metin</SectionLabel>
      <ul className="flex flex-col gap-px">
        {text.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => select(space.id, c.id)}
              aria-current={c.id === active ? "page" : undefined}
              className={cn(
                "group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-paper-2",
                c.id === active ? "bg-paper-2 text-ink-1 shadow-[inset_2px_0_0_var(--copper)] hover:bg-paper-2" : c.unread ? "font-medium text-ink-1" : "text-ink-2",
              )}
            >
              <Hash className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.private_roles && <Lock className="size-3 text-ink-3" aria-label="Özel kanal" />}
              {c.unread > 0 && c.id !== active && (
                <span className="num min-w-4 rounded-[4px] bg-copper-soft px-1 text-center text-2xs font-semibold text-copper">
                  {c.unread > 99 ? "99+" : c.unread}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="h-3" />
      <SectionLabel action={add}>Ses</SectionLabel>
      <ul className="flex flex-col gap-px">
        {voice.map((c) => (
          <VoiceRow key={c.id} space={space} c={c} active={c.id === active} joined={c.id === voiceCh} />
        ))}
      </ul>
    </nav>
  );
}

function VoiceRow({ space, c, active, joined }: { space: SpaceView; c: ChannelView; active: boolean; joined: boolean }) {
  const live = c.voice.length > 0;
  return (
    <li>
      <button
        onClick={() => useApp.getState().select(space.id, c.id)}
        onDoubleClick={() => void joinVoice(space.id, c.id)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-paper-2",
          active ? "bg-paper-2 text-ink-1 shadow-[inset_2px_0_0_var(--copper)] hover:bg-paper-2" : "text-ink-2",
        )}
      >
        <Volume2 className={cn("size-3.5 shrink-0", joined ? "text-live" : "text-ink-3")} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
        {c.private_roles && <Lock className="size-3 text-ink-3" />}
        {c.unread > 0 && <span className="size-1.5 shrink-0 rounded-full bg-copper" role="img" aria-label="Okunmamış mesajlar" />}
        {live && (
          <span className="flex items-center gap-1">
            <span className="flex -space-x-1">
              {c.voice.slice(0, 4).map((id) => {
                const m = memberOf(space, id);
                return <Avatar key={id} id={id} name={m?.name ?? "?"} size={16} className="ring-[1.5px] ring-paper-0" />;
              })}
            </span>
            {c.voice.length > 4 && <span className="num text-2xs text-ink-3">+{c.voice.length - 4}</span>}
            {c.streams.length > 0 && <MonitorUp className="size-3 text-copper" aria-label="Ekran paylaşılıyor" />}
          </span>
        )}
      </button>
    </li>
  );
}

/** One line while connected: where you are, a live level hairline, mute and leave. The full controls live in the stage dock. */
function VoiceStatus() {
  const v = useApp((s) => s.snap!.voice!);
  const me = useApp((s) => s.snap!.me);
  const ptt = useApp((s) => s.snap!.settings.push_to_talk && s.snap!.settings.ptt_key);
  const space = useApp((s) => s.snap!.spaces.find((x) => x.id === v.space));
  const room = space?.channels.find((c) => c.id === v.channel);
  const meter = useMemo(() => levelRef(me.id), [me.id]);
  const small = "size-7 [&_svg]:size-3.5";
  return (
    <div className="enter relative flex items-center gap-1 border-t border-line py-1.5 pr-1.5 pl-2">
      <button
        onClick={() => space && room && useApp.getState().select(space.id, room.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-paper-2"
        aria-label={`${room?.name ?? "Ses odası"} odasına git`}
      >
        <span className="relative size-2 shrink-0">
          <span className="absolute inset-0 rounded-full bg-live" />
          <span className="absolute inset-0 animate-[pulse-live_2s_ease-in-out_infinite] rounded-full bg-live" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium text-live">{room?.name ?? "…"}</span>
          <span className="text-ink-3"> · {space?.name}</span>
        </span>
        {ptt && <Kbd>{ptt.replace(/^Key|^Digit/, "")}</Kbd>}
      </button>
      <IconBtn label={v.muted ? "Mikrofonu aç" : "Mikrofonu kapat"} shortcut={MUTE_SHORTCUT} onClick={toggleMute} aria-pressed={v.muted} className={cn(small, v.muted && "bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger")}>
        {v.muted ? <MicOff /> : <Mic />}
      </IconBtn>
      <IconBtn label="Odadan ayrıl" onClick={leaveVoice} className={cn(small, "hover:bg-danger-soft hover:text-danger")}>
        <PhoneOff />
      </IconBtn>
      <div className="absolute inset-x-3 top-0 h-px overflow-hidden" aria-hidden>
        <div ref={meter} className="h-full origin-left bg-live will-change-transform" style={{ transform: "scaleX(var(--lvl))" }} />
      </div>
    </div>
  );
}

function UserBar() {
  const me = useApp((s) => s.snap!.me);
  const online = useApp((s) => s.snap!.online);
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line px-2.5">
      <button
        type="button"
        aria-label="Profilim"
        aria-haspopup="dialog"
        onClick={(e) => useApp.getState().openProfile(me.id, undefined, e.currentTarget)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-paper-2"
      >
        <Avatar id={me.id} name={me.name} size={26} online={online} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium tracking-tight">{me.name}</span>
          <span className="block truncate text-2xs text-ink-3">{online ? "Çevrimiçi" : "Ağa bağlanılıyor…"}</span>
        </span>
      </button>
      <IconBtn label="Ayarlar" onClick={() => useApp.getState().openDialog("app-settings")}>
        <Settings />
      </IconBtn>
    </div>
  );
}

export { SpaceGlyph };
