import { useMemo } from "react";
import { Crown, Copy, HeadphoneOff, MicOff, MonitorUp, Volume2 } from "lucide-react";
import { call, type MemberView, type RoleView, type SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, hex, myRank, outranks, shortId, topRole } from "@/lib/space";
import { copy, fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Slider } from "@/components/ui/slider";
import { Avatar } from "./common";

interface Group {
  key: string;
  label: string;
  color: number | null;
  members: MemberView[];
}

export function MembersPanel({ space }: { space: SpaceView }) {
  const groups = useMemo(() => {
    const byRole = new Map<string, Group>();
    const offline: MemberView[] = [];
    const sorted = [...space.members].sort((a, b) => a.name.localeCompare(b.name, "tr"));
    for (const m of sorted) {
      if (!m.online) {
        offline.push(m);
        continue;
      }
      const r = topRole(space, m);
      const key = r?.id ?? "_";
      let g = byRole.get(key);
      if (!g) byRole.set(key, (g = { key, label: r?.name ?? "Üyeler", color: r?.color ?? null, members: [] }));
      g.members.push(m);
    }
    const rank = (k: string) => space.roles.find((r) => r.id === k)?.rank ?? -1;
    const out = [...byRole.values()].sort((a, b) => rank(b.key) - rank(a.key));
    if (offline.length) out.push({ key: "_off", label: "Çevrimdışı", color: null, members: offline });
    return out;
  }, [space]);

  return (
    <aside
      className="members enter flex w-[232px] shrink-0 flex-col overflow-y-auto border-l border-line bg-paper-1 px-2 py-3 [--dot-ring:var(--paper-1)] max-[1099px]:absolute max-[1099px]:top-11 max-[1099px]:right-0 max-[1099px]:bottom-0 max-[1099px]:z-20 max-[1099px]:shadow-pop"
      aria-label="Üyeler"
    >
      {groups.map((g) => (
        <section key={g.key} className="mb-3">
          <div className="flex h-6 items-center gap-1.5 px-2 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            {g.color !== null && <span className="size-1.5 rounded-full" style={{ background: hex(g.color) }} />}
            <span className="truncate">{g.label}</span>
            <span className="num ml-auto">{g.members.length}</span>
          </div>
          <ul className="flex flex-col gap-px">
            {g.members.map((m) => (
              <MemberRow key={m.id} space={space} m={m} />
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function MemberRow({ space, m }: { space: SpaceView; m: MemberView }) {
  const v = m.voice;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            tabIndex={0}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2 outline-none hover:bg-paper-3 focus-visible:bg-paper-3 data-[state=open]:bg-paper-3",
              !m.online && "opacity-55",
            )}
          >
            <Avatar id={m.id} name={m.name} size={24} online={m.online} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-1">{m.name}</span>
            {m.is_owner && <Crown className="size-3 shrink-0 text-copper" aria-label="Kurucu" />}
            {v?.streaming && <MonitorUp className="size-3 shrink-0 text-copper" />}
            {v && (v.deafened ? <HeadphoneOff className="size-3 shrink-0 text-ink-3" /> : v.muted ? <MicOff className="size-3 shrink-0 text-ink-3" /> : <Volume2 className="size-3 shrink-0 text-live" />)}
          </div>
        </ContextMenuTrigger>
        <MemberMenuContent space={space} m={m} />
      </ContextMenu>
    </li>
  );
}

export function MemberMenuContent({ space, m }: { space: SpaceView; m: MemberView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const volume = useApp((s) => s.peerVolume[m.id] ?? 1);
  const self = m.id === meId;
  const above = outranks(space, meId, m);
  const mine = myRank(space, meId);
  const assignable: RoleView[] =
    has(space, "manage_roles") && (above || self)
      ? [...space.roles].filter((r) => r.rank < mine).sort((a, b) => b.rank - a.rank)
      : [];
  const canKick = has(space, "kick") && above;
  const canBan = has(space, "ban") && above;
  const conn = m.conn === "direct" ? "doğrudan" : m.conn === "relay" ? "relay" : m.conn === "self" ? "sen" : "bağlı değil";

  return (
    <ContextMenuContent className="w-[232px]">
      <ContextMenuLabel className="flex items-center gap-2 py-1.5">
        <Avatar id={m.id} name={m.name} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{m.name}</span>
          <span className="num block truncate font-mono text-[10.5px] font-normal text-ink-3">
            {shortId(m.id)} · {conn}
            {m.rtt_ms !== null && ` · ${m.rtt_ms} ms`}
          </span>
        </span>
      </ContextMenuLabel>
      {!self && (
        <>
          <ContextMenuSeparator />
          <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between text-xs text-ink-2">
              <span>Ses seviyesi</span>
              <span className="num text-ink-3">{Math.round(volume * 100)}%</span>
            </div>
            <Slider
              min={0}
              max={200}
              step={5}
              value={[Math.round(volume * 100)]}
              onValueChange={([v]) => useApp.getState().setPeerVolume(m.id, v / 100)}
              aria-label={`${m.name} ses seviyesi`}
            />
          </div>
        </>
      )}
      {assignable.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>Roller</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-[200px]">
              {assignable.map((r) => (
                <ContextMenuCheckboxItem
                  key={r.id}
                  checked={m.roles.includes(r.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => void call("assign_role", { space: space.id, member: m.id, role: r.id, on }).catch(fail)}
                >
                  <span className="size-1.5 rounded-full" style={{ background: hex(r.color) }} />
                  {r.name}
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copy(m.id, "Kimlik kopyalandı")}>
        <Copy /> Kimliği kopyala
      </ContextMenuItem>
      {(canKick || canBan) && <ContextMenuSeparator />}
      {canKick && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-danger data-[state=open]:text-danger">Halkadan at</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem variant="destructive" onSelect={() => void call("kick", { space: space.id, member: m.id }).catch(fail)}>
              Evet, {m.name} çıkarılsın
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      {canBan && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-danger data-[state=open]:text-danger">Yasakla</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem variant="destructive" onSelect={() => void call("ban", { space: space.id, member: m.id, on: true }).catch(fail)}>
              Evet, kalıcı olarak yasakla
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </ContextMenuContent>
  );
}

