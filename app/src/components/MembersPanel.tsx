import { useEffect, useMemo, useState } from "react";
import { Crown, Copy, GripVertical, HeadphoneOff, MicOff, MonitorUp, Volume2 } from "lucide-react";
import { call, type Id, type MemberView, type RoleView, type SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, hex, myRank, outranks, shortId, topRole } from "@/lib/space";
import { moveRole } from "@/lib/roleOrder";
import { copy, fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { linkLabel } from "@/lib/link";
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
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar } from "./common";
import { ProfilePanel } from "./ProfilePanel";

interface Group {
  key: string;
  label: string;
  role?: RoleView;
  members: MemberView[];
}

export function MembersPanel({ space, open }: { space: SpaceView; open: boolean }) {
  const meId = useApp((s) => s.snap?.me.id);
  const owner = space.owner === meId;
  const [profile, setProfile] = useState<Id | null>(null);
  const [dragged, setDragged] = useState<Id | null>(null);
  const [dropTarget, setDropTarget] = useState<Id | null>(null);
  const [pending, setPending] = useState<{ source: string; roles: RoleView[] }>();
  const rankKey = space.roles.map((r) => `${r.id}:${r.rank}`).sort().join(",");
  const moving = pending?.source === rankKey ? pending : undefined;
  const roles = moving?.roles ?? space.roles;

  useEffect(() => {
    if (!open) setProfile(null);
  }, [open]);
  useEffect(() => {
    if (pending && pending.source !== rankKey) setPending(undefined);
  }, [pending, rankKey]);

  const groups = useMemo(() => {
    const display = { ...space, roles };
    const byRole = new Map<string, Group>();
    const sorted = [...space.members].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "tr"));
    for (const m of sorted) {
      const role = topRole(display, m);
      const key = m.is_owner ? "_owner" : role?.id ?? (m.online ? "_" : "_off");
      let g = byRole.get(key);
      const label = m.is_owner ? "Kurucu" : role?.name ?? (m.online ? "Üyeler" : "Çevrimdışı");
      if (!g) byRole.set(key, (g = { key, label, role: m.is_owner ? undefined : role, members: [] }));
      g.members.push(m);
    }
    const rank = (g: Group) => g.key === "_owner" ? Number.MAX_SAFE_INTEGER : g.role?.rank ?? (g.key === "_off" ? -2 : -1);
    return [...byRole.values()].sort((a, b) => rank(b) - rank(a) || a.key.localeCompare(b.key));
  }, [space, roles]);

  const movable = groups.filter((g) => g.role && g.role.id !== space.id);
  const canMove = owner && movable.length > 1 && !moving;
  const reorder = async (role: Id, target: Id) => {
    if (!canMove) return;
    const roles = moveRole(space.roles, space.id, role, target);
    if (!roles) return;
    const change = { source: rankKey, roles };
    setPending(change);
    try {
      await call("move_role", { space: space.id, role, target });
    } catch (error) {
      setPending((current) => current === change ? undefined : current);
      fail(error);
    }
  };

  return (
    <div className="members-drawer shrink-0 overflow-hidden" data-open={open} inert={!open}>
      <aside
        id="members-panel"
        className="h-full overflow-y-auto border-l border-line bg-paper-1 px-2 py-3 [--dot-ring:var(--paper-1)]"
        aria-label="Üyeler"
      >
        {groups.map((g) => {
          const index = movable.indexOf(g);
          const draggable = canMove && index >= 0;
          return (
            <section key={g.key} className="mb-3">
              <div
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded px-2 text-2xs font-medium tracking-wide text-ink-3 uppercase",
                  dropTarget === g.key && "bg-paper-3 text-copper",
                )}
                onDragOver={draggable ? (event) => {
                  if (!dragged || dragged === g.key) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTarget(g.key);
                } : undefined}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setDropTarget((current) => current === g.key ? null : current);
                }}
                onDrop={draggable ? (event) => {
                  event.preventDefault();
                  if (dragged) void reorder(dragged, g.key);
                  setDragged(null);
                  setDropTarget(null);
                } : undefined}
              >
                {g.role && <span className="size-1.5 shrink-0 rounded-full" style={{ background: hex(g.role.color) }} />}
                <span className="truncate">{g.label}</span>
                <span className="num ml-auto">{g.members.length}</span>
                {owner && movable.length > 1 && index >= 0 && (
                  <button
                    type="button"
                    className="grid size-5 shrink-0 cursor-grab place-items-center rounded hover:bg-paper-3 hover:text-ink-1 active:cursor-grabbing aria-disabled:opacity-40"
                    title="Sürükle veya ok tuşlarıyla taşı"
                    aria-label={`${g.label} rolünü sırala`}
                    aria-disabled={!draggable}
                    draggable={draggable}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", g.key);
                      setDragged(g.key);
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => {
                      const offset = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                      if (!offset) return;
                      event.preventDefault();
                      const target = movable[index + offset];
                      if (target) void reorder(g.key, target.key);
                    }}
                  >
                    <GripVertical className="size-3" />
                  </button>
                )}
              </div>
              <ul className="flex flex-col gap-px">
                {g.members.map((m) => (
                  <MemberRow
                    key={m.id}
                    space={space}
                    m={m}
                    role={m.is_owner ? topRole({ ...space, roles }, m) : g.role}
                    open={open && profile === m.id}
                    onOpenChange={(next) => setProfile((current) => next ? m.id : current === m.id ? null : current)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </aside>
    </div>
  );
}

function MemberRow({ space, m, role, open, onOpenChange }: {
  space: SpaceView;
  m: MemberView;
  role?: RoleView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const v = m.voice;
  return (
    <li>
      <Popover open={open} onOpenChange={onOpenChange}>
        <ContextMenu>
          <PopoverTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-paper-3 focus-visible:bg-paper-3 aria-expanded:bg-paper-3 data-[state=open]:bg-paper-3",
                  !m.online && "opacity-55",
                )}
              >
                <Avatar id={m.id} name={m.name} size={24} online={m.online} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-1" style={{ color: role && hex(role.color) }}>{m.name}</span>
                {m.is_owner && <Crown className="size-3 shrink-0 text-copper" aria-label="Kurucu" />}
                {v?.streaming && <MonitorUp className="size-3 shrink-0 text-copper" />}
                {v && (v.deafened ? <HeadphoneOff className="size-3 shrink-0 text-ink-3" /> : v.muted ? <MicOff className="size-3 shrink-0 text-ink-3" /> : <Volume2 className="size-3 shrink-0 text-live" />)}
              </button>
            </ContextMenuTrigger>
          </PopoverTrigger>
          <MemberMenuContent space={space} m={m} />
        </ContextMenu>
        <PopoverContent
          side="left"
          align="start"
          sideOffset={12}
          collisionPadding={8}
          hideWhenDetached
          aria-label={`${m.name} profili`}
          className="glass w-[min(320px,calc(100dvw-16px))] overflow-hidden rounded-lg p-0"
        >
          <ProfilePanel member={m.id} space={space.id} compact>
            <MemberManagement space={space} member={m} />
          </ProfilePanel>
        </PopoverContent>
      </Popover>
    </li>
  );
}

export function MemberManagement({ space, member }: { space: SpaceView; member: MemberView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"kick" | "ban">();
  const above = member.id !== meId && outranks(space, meId, member);
  const canKick = above && has(space, "kick");
  const canBan = above && has(space, "ban");
  const mine = myRank(space, meId);
  const roles = above && has(space, "manage_roles")
    ? space.roles.filter((r) => r.id !== space.id && r.rank < mine).sort((a, b) => b.rank - a.rank)
    : [];
  if (!canKick && !canBan && roles.length === 0) return null;

  const target = { space: space.id, member: member.id };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={busy} className="space-y-2 rounded-md border border-line px-2.5 pb-2.5">
      <legend className="px-1 text-xs font-semibold text-ink-2">Üyeyi yönet</legend>
      {roles.length > 0 && (
        <details>
          <summary className="w-fit cursor-pointer rounded text-xs font-medium">Rolleri düzenle</summary>
          <div className="mt-1 grid gap-1">
            {roles.map((role) => (
              <label key={role.id} className="flex min-w-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  className="accent-copper"
                  checked={member.roles.includes(role.id)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    void run(() => call("assign_role", { ...target, role: role.id, on }));
                  }}
                />
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: hex(role.color) }} />
                <span className="truncate">{role.name}</span>
              </label>
            ))}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-1.5">
        {confirm ? (
          <>
            <Button size="xs" variant="destructive" onClick={() => void run(() => confirm === "kick"
              ? call("kick", target)
              : call("ban", { ...target, on: true }))}>
              {confirm === "kick" ? "Çıkarmayı onayla" : "Yasaklamayı onayla"}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirm(undefined)}>Vazgeç</Button>
          </>
        ) : (
          <>
            {canKick && <Button size="xs" variant="ghost" className="text-danger" onClick={() => setConfirm("kick")}>Halkadan çıkar</Button>}
            {canBan && <Button size="xs" variant="ghost" className="text-danger" onClick={() => setConfirm("ban")}>Yasakla</Button>}
          </>
        )}
      </div>
    </fieldset>
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
  const meHidden = useApp((s) => s.snap?.active_relay_only ?? false);
  const conn = linkLabel(m, meHidden)?.text ?? (m.conn === "self" ? "sen" : "bağlı değil");

  return (
    <ContextMenuContent className="w-[232px]">
      <ContextMenuLabel className="flex items-center gap-2 py-1.5">
        <Avatar id={m.id} name={m.name} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{m.name}</span>
          <span className="num block truncate font-mono text-[10.5px] font-normal text-ink-3">
            {shortId(m.id)} · {conn}
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

