import { useEffect, useMemo, useState } from "react";
import { TTL_OPTIONS } from "./Attachments";
import { ArrowDown, ArrowUp, Ban, ChevronRight, Hash, Lock, Plus, Settings2, Shield, ShieldCheck, Ticket, Users, Volume2 } from "lucide-react";
import { enableRelay } from "@/lib/relay";
import { MemberManagement } from "./MembersPanel";
import { call, type ChannelKind, type ChannelView, type Id, type Perm, type RoleView, type SpaceView } from "@/ipc";
import { useApp } from "@/state/store";
import { has, hex, memberOf, myRank, nameOf, shortId, useSpace } from "@/lib/space";
import { relFuture } from "@/lib/time";
import { fail } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Avatar, ConnExplainer, Empty, Field, Segmented } from "./common";
import { InviteCreator } from "./InviteCreator";
import { Group, PaneTitle, Row, SettingsLayout, type Tab } from "./SettingsLayout";
import { useSubmit } from "./forms";

type TabId = "general" | "connection" | "members" | "channels" | "roles" | "invites" | "bans";

export function SpaceSettings({ initialTab }: { initialTab?: string }) {
  const space = useSpace();
  const tabs = useMemo(() => {
    const t: Tab<TabId>[] = [
      { id: "general", label: "Genel", icon: <Settings2 /> },
      { id: "connection", label: "Bağlantı", icon: <ShieldCheck /> },
      { id: "members", label: "Üyeler", icon: <Users /> },
    ];
    if (has(space, "manage_channels")) t.push({ id: "channels", label: "Kanallar", icon: <Hash /> });
    if (has(space, "manage_roles")) t.push({ id: "roles", label: "Roller", icon: <Shield /> });
    if (has(space, "invite")) t.push({ id: "invites", label: "Davetler", icon: <Ticket /> });
    if (has(space, "ban")) t.push({ id: "bans", label: "Yasaklılar", icon: <Ban /> });
    return t;
  }, [space]);
  const [tab, setTab] = useState<TabId>(tabs.some((t) => t.id === initialTab) ? (initialTab as TabId) : "general");
  if (!space) return null;
  return (
    <SettingsLayout title="Halka yönetimi" subtitle={space.name} tabs={tabs} tab={tab} setTab={setTab}>
      {tab === "general" ? (
        <General space={space} leaveOpen={initialTab === "leave"} />
      ) : tab === "connection" ? (
        <Connection space={space} />
      ) : tab === "members" ? (
        <Members space={space} />
      ) : tab === "channels" ? (
        <Channels space={space} />
      ) : tab === "roles" ? (
        <Roles space={space} />
      ) : tab === "invites" ? (
        <Invites space={space} />
      ) : (
        <Bans space={space} />
      )}
    </SettingsLayout>
  );
}

/** Two-step destructive button: first click arms, second confirms; disarms after 3 s. */
function ConfirmButton({ label, confirm, onConfirm, size = "sm" }: { label: string; confirm: string; onConfirm: () => void; size?: "sm" | "default" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button size={size} variant={armed ? "destructive" : "ghost"} className={cn(!armed && "text-ink-3 hover:text-danger")} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? confirm : label}
    </Button>
  );
}

function General({ space, leaveOpen }: { space: SpaceView; leaveOpen: boolean }) {
  const meId = useApp((s) => s.snap!.me.id);
  const [name, setName] = useState(space.name);
  const canRename = has(space, "manage_space");
  const save = useSubmit(() => call("rename_space", { space: space.id, name: name.trim() }));
  const isOwner = space.owner === meId;
  return (
    <>
      <PaneTitle title="Genel" />
      <Group>
        <div className="py-3">
          <Field label="Halka adı" hint={canRename ? undefined : "Adı değiştirme iznin yok."}>
            <div className="flex gap-2">
              <input className="field" value={name} maxLength={48} disabled={!canRename} onChange={(e) => setName(e.target.value)} />
              {canRename && (
                <Button disabled={!name.trim() || name.trim() === space.name} aria-busy={save.busy} onClick={() => void save.run()}>
                  Kaydet
                </Button>
              )}
            </div>
          </Field>
          {save.error && <p className="mt-1 text-xs text-danger">{save.error}</p>}
        </div>
        <Row label="Kurucu">
          <span className="text-xs text-ink-2">{nameOf(space, space.owner)}</span>
        </Row>
        <Row label="Üye sayısı">
          <span className="num text-xs text-ink-2">{space.members.length}</span>
        </Row>
        <Row label="Halka kimliği">
          <span className="font-mono text-2xs text-ink-3" data-selectable>
            {shortId(space.id)}
          </span>
        </Row>
      </Group>
      <Group title="Tehlikeli bölge">
        {isOwner ? (
          <DeleteSpace space={space} />
        ) : (
          <Row label="Halkadan ayrıl" desc="Mesaj geçmişi bu cihazdan kaldırılır.">
            <LeaveButton space={space} armed={leaveOpen} />
          </Row>
        )}
      </Group>
    </>
  );
}

/** Irreversible for every member, so the name must be typed back. */
function DeleteSpace({ space }: { space: SpaceView }) {
  const [typed, setTyped] = useState<string | null>(null);
  const close = useApp((s) => s.closeDialog);
  const del = useSubmit(() => call("delete_space", { space: space.id }), close);
  return typed === null ? (
    <Row label="Halkayı sil" desc="Halka, kanalları ve mesajları bütün üyeler için kalıcı olarak silinir. Geri alınamaz.">
      <Button size="sm" variant="destructive" onClick={() => setTyped("")}>
        Sil
      </Button>
    </Row>
  ) : (
    <form
      className="grid gap-2 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (typed === space.name) void del.run();
      }}
    >
      <label htmlFor="delete-confirm" className="text-xs text-ink-2">
        Onaylamak için halkanın adını yaz: <span className="font-medium text-ink-1" data-selectable>{space.name}</span>
      </label>
      <input id="delete-confirm" className="field" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      {del.error && <p className="text-xs text-danger">{del.error}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="destructive" disabled={typed !== space.name} aria-busy={del.busy}>
          {del.busy ? "Siliniyor…" : "Halkayı kalıcı olarak sil"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setTyped(null)}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- connection

function Connection({ space }: { space: SpaceView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const relayActive = useApp((s) => s.snap!.active_relay_only);
  const [armed, setArmed] = useState(false);
  const isOwner = space.owner === meId;
  const turnOn = useSubmit(async () => {
    await call("require_relay", { space: space.id });
    // the owner's own device must follow, or the halka locks for them too
    if (!relayActive) await enableRelay();
  });
  return (
    <>
      <PaneTitle title="Bağlantı" desc="Üyelerin birbirine nasıl bağlandığını belirler." />
      <Group>
        <Row
          label="Relay şart"
          desc={space.relay_required ? "Açık. Üyeler yalnızca relay üzerinden bağlanır, IP adresleri gizli." : "Kapalı. Üyeler doğrudan bağlanabilir."}
        >
          {space.relay_required ? (
            <span className="flex items-center gap-1 text-xs text-live">
              <ShieldCheck className="size-3.5" /> Açık
            </span>
          ) : isOwner && !armed ? (
            <Button size="sm" variant="secondary" onClick={() => setArmed(true)}>
              Zorunlu yap
            </Button>
          ) : (
            <span className="text-xs text-ink-3">Kapalı</span>
          )}
        </Row>
        {armed && !space.relay_required && (
          <div className="grid gap-2 border-b border-line py-3">
            <p className="text-xs text-ink-2">
              Bu işlem geri alınamaz. Mevcut davet kodları iptal edilir; relay’i açmamış üyeler açana kadar halkaya erişemez.
              {relayActive ? "" : " Senin uygulaman da relay’e geçip yeniden başlar."}
            </p>
            {turnOn.error && <p className="text-xs text-danger">{turnOn.error}</p>}
            <div className="flex gap-1.5">
              <Button size="sm" disabled={turnOn.busy} aria-busy={turnOn.busy} onClick={() => void turnOn.run()}>
                {turnOn.busy ? "Uygulanıyor…" : "Relay’i zorunlu yap"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
                Vazgeç
              </Button>
            </div>
          </div>
        )}
        <ConnExplainer className="py-3" />
      </Group>
      {!isOwner && !space.relay_required && <p className="text-2xs text-ink-3">Bu ayarı yalnızca kurucu değiştirebilir.</p>}
    </>
  );
}

// ---------------------------------------------------------------- members

function Members({ space }: { space: SpaceView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const [open, setOpen] = useState<Id | null>(null);
  const [q, setQ] = useState("");
  const needle = q.trim().toLocaleLowerCase("tr");
  const list = space.members
    .filter((m) => m.name.toLocaleLowerCase("tr").includes(needle))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "tr"));
  return (
    <>
      <PaneTitle title="Üyeler" desc={`${space.members.length} üye. Bir üyeye tıklayarak rollerini ve erişimini yönet.`} />
      <input className="field mb-2" placeholder="Üye ara" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Üye ara" />
      <div className="rounded-lg border border-line">
        {list.map((m) => {
          const roles = space.roles.filter((r) => m.roles.includes(r.id) && r.id !== space.id);
          const expanded = open === m.id;
          return (
            <div key={m.id} className="border-b border-line last:border-b-0">
              <button
                onClick={() => setOpen(expanded ? null : m.id)}
                aria-expanded={expanded}
                className="flex h-10 w-full items-center gap-2.5 px-3 text-left hover:bg-paper-2"
              >
                <Avatar id={m.id} name={m.name} size={22} online={m.online} />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {m.name}
                  {m.id === meId && <span className="text-ink-3"> (sen)</span>}
                </span>
                {m.id === space.owner ? (
                  <span className="text-2xs text-copper">Kurucu</span>
                ) : (
                  roles.slice(0, 2).map((r) => (
                    <span key={r.id} className="flex items-center gap-1 text-2xs text-ink-3">
                      <span className="size-1.5 rounded-full" style={{ background: hex(r.color) }} />
                      {r.name}
                    </span>
                  ))
                )}
                <span className="w-16 text-right text-2xs text-ink-3">
                  {m.conn === "direct" ? "doğrudan" : m.conn === "relay" ? "relay" : m.conn === "self" ? "" : "bağlı değil"}
                </span>
                <ChevronRight className={cn("size-3.5 text-ink-3 transition-transform duration-150", expanded && "rotate-90")} />
              </button>
              {expanded && (
                <div className="grid gap-1 px-3 pb-3">
                  <MemberManagement space={space} member={m} />
                  {(m.id === meId || m.id === space.owner) && (
                    <p className="text-2xs text-ink-3">{m.id === meId ? "Kendini buradan yönetemezsin." : "Kurucu yönetilemez."}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function LeaveButton({ space, armed }: { space: SpaceView; armed: boolean }) {
  const [on, setOn] = useState(armed);
  const close = useApp((s) => s.closeDialog);
  return on ? (
    <div className="flex gap-1.5">
      <Button size="sm" variant="ghost" onClick={() => setOn(false)}>
        Vazgeç
      </Button>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => {
          close();
          void call("leave_space", { space: space.id }).catch(fail);
        }}
      >
        Evet, ayrıl
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="destructive" onClick={() => setOn(true)}>
      Ayrıl
    </Button>
  );
}

// ---------------------------------------------------------------- channels

function Channels({ space }: { space: SpaceView }) {
  const [open, setOpen] = useState<Id | "new" | null>(null);
  const ordered = [...space.channels.filter((c) => c.kind === "text"), ...space.channels.filter((c) => c.kind === "voice")];
  return (
    <>
      <PaneTitle
        title="Kanallar"
        desc="Özel kanalları yalnızca seçtiğin roller (ve yöneticiler) görür."
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen("new")}>
            <Plus /> Kanal
          </Button>
        }
      />
      {open === "new" && <ChannelEditor space={space} onDone={() => setOpen(null)} />}
      <div className="rounded-lg border border-line">
        {ordered.map((c) => (
          <div key={c.id} className="border-b border-line last:border-b-0">
            <button onClick={() => setOpen(open === c.id ? null : c.id)} className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-paper-2">
              {c.kind === "text" ? <Hash className="size-3.5 text-ink-3" /> : <Volume2 className="size-3.5 text-ink-3" />}
              <span className="flex-1 truncate text-[13px]">{c.name}</span>
              {c.private_roles ? (
                <span className="flex items-center gap-1 text-2xs text-ink-3">
                  <Lock className="size-3" /> {c.private_roles.length} rol
                </span>
              ) : (
                <span className="text-2xs text-ink-3">Herkese açık</span>
              )}
            </button>
            {open === c.id && <ChannelEditor space={space} channel={c} onDone={() => setOpen(null)} />}
          </div>
        ))}
      </div>
    </>
  );
}

function ChannelEditor({ space, channel, onDone }: { space: SpaceView; channel?: ChannelView; onDone: () => void }) {
  const [name, setName] = useState(channel?.name ?? "");
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "text");
  const [priv, setPriv] = useState<Id[] | null>(channel?.private_roles ?? null);
  const [ttl, setTtl] = useState(String(channel?.ttl_ms ?? "off"));
  const save = useSubmit(async () => {
    const n = name.trim();
    if (channel) {
      await call("update_channel", { space: space.id, channel: channel.id, name: n, privateRoles: priv });
      const next = ttl === "off" ? null : Number(ttl);
      if (next !== channel.ttl_ms) await call("set_channel_ttl", { space: space.id, channel: channel.id, ttlMs: next });
    } else await call("create_channel", { space: space.id, name: n, kind, privateRoles: priv });
  }, onDone);
  const toggleRole = (id: Id) => setPriv((p) => (p ?? []).includes(id) ? (p ?? []).filter((x) => x !== id) : [...(p ?? []), id]);
  return (
    <div className={cn("enter flex flex-col gap-3 bg-paper-2/50 p-3", !channel && "mb-3 rounded-lg border border-line-2")}>
      {!channel && (
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "text", label: "Metin kanalı" },
            { value: "voice", label: "Ses odası" },
          ]}
          className="w-fit"
        />
      )}
      <Field label="Ad">
        <input className="field" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px]">Özel kanal</div>
          <div className="text-xs text-ink-3">Yalnızca seçilen roller görebilir.</div>
        </div>
        <Switch checked={priv !== null} onCheckedChange={(v) => setPriv(v ? [] : null)} aria-label="Özel kanal" />
      </div>
      {priv !== null && (
        <div className="flex flex-wrap gap-1.5">
          {space.roles.length === 0 && <span className="text-xs text-ink-3">Henüz rol yok. Önce Roller sekmesinden bir rol oluştur.</span>}
          {space.roles.map((r) => (
            <button
              key={r.id}
              onClick={() => toggleRole(r.id)}
              aria-pressed={priv.includes(r.id)}
              className="flex h-6 items-center gap-1.5 rounded-md border border-line-2 px-2 text-xs text-ink-2 transition-colors hover:text-ink-1 aria-pressed:border-copper/60 aria-pressed:bg-copper-soft aria-pressed:text-ink-1"
            >
              <span className="size-1.5 rounded-full" style={{ background: hex(r.color) }} />
              {r.name}
            </button>
          ))}
        </div>
      )}
      {channel && (
        <div className="flex flex-col gap-1.5">
          <div>
            <div className="text-[13px]">Süreli mesajlar</div>
            <div className="text-xs text-ink-3">Yeni mesajlar en geç bu süre dolunca her cihazdan geri dönüşsüz silinir. Gönderen süreyi kısaltabilir, uzatamaz.</div>
          </div>
          <Segmented
            value={ttl}
            onChange={setTtl}
            options={[{ value: "off", label: "Kapalı" }, ...TTL_OPTIONS.map((o) => ({ value: String(o.ms), label: o.short }))]}
            className="w-fit"
          />
        </div>
      )}
      {save.error && <p className="text-xs text-danger">{save.error}</p>}
      <div className="flex items-center gap-2">
        {channel && (
          <ConfirmButton label="Kanalı sil" confirm="Mesajlarla birlikte silinsin mi?" onConfirm={() => void call("delete_channel", { space: space.id, channel: channel.id }).then(onDone, fail)} />
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onDone}>
          Vazgeç
        </Button>
        <Button size="sm" disabled={!name.trim()} aria-busy={save.busy} onClick={() => void save.run()}>
          {channel ? "Kaydet" : "Oluştur"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- roles

export const PERMS: { id: Perm; label: string; desc: string }[] = [
  { id: "admin", label: "Yönetici", desc: "Her şeye izin verir; özel kanalları da görür." },
  { id: "manage_space", label: "Halkayı düzenle", desc: "Halkanın adını değiştirebilir." },
  { id: "manage_channels", label: "Kanalları yönet", desc: "Kanal oluşturur, düzenler ve siler." },
  { id: "manage_roles", label: "Rolleri yönet", desc: "Kendi rolünün altındaki rolleri düzenler ve atar." },
  { id: "manage_messages", label: "Mesajları yönet", desc: "Başkalarının mesajlarını silebilir." },
  { id: "kick", label: "Üye çıkar", desc: "Daha alt rütbedeki üyeleri halkadan atabilir." },
  { id: "ban", label: "Üye yasakla", desc: "Daha alt rütbedeki üyeleri kalıcı olarak engeller." },
  { id: "invite", label: "Davet oluştur", desc: "Yeni davet kodları üretebilir." },
  { id: "send", label: "Mesaj yaz", desc: "Metin kanallarına yazabilir." },
  { id: "speak", label: "Sesli konuş", desc: "Ses odalarına katılıp konuşabilir." },
  { id: "stream", label: "Ekran paylaş", desc: "Ses odalarında ekranını paylaşabilir." },
];

export const SWATCHES = [0xd9925b, 0xc9a14a, 0x9bb05a, 0x6fb39a, 0x5aa6b8, 0x7fa3d6, 0x9a8fd1, 0xc983a8, 0xd77a6f, 0x9c9488, 0xb8b0a2, 0x6b8f71];

function Roles({ space }: { space: SpaceView }) {
  const meId = useApp((s) => s.snap!.me.id);
  const mine = myRank(space, meId);
  const roles = useMemo(() => [...space.roles].sort((a, b) => b.rank - a.rank), [space.roles]);
  const [sel, setSel] = useState<Id | null>(roles.find((r) => r.rank < mine)?.id ?? roles[0]?.id ?? null);
  const role = roles.find((r) => r.id === sel) ?? null;

  const create = async () => {
    const below = roles.filter((r) => r.rank < mine);
    const rank = below.length ? Math.max(1, Math.min(...below.map((r) => r.rank)) - 1) : Number.isFinite(mine) ? Math.max(0, mine - 1) : 10;
    try {
      const id = await call("create_role", { space: space.id, name: "Yeni rol", color: SWATCHES[roles.length % SWATCHES.length], perms: ["send", "speak"], rank });
      setSel(id);
    } catch (e) {
      fail(e);
    }
  };

  // Swap ranks with the neighbour; both roles must sit below my own rank.
  const move = async (r: RoleView, dir: -1 | 1) => {
    const i = roles.indexOf(r);
    const other = roles[i + dir];
    if (!other || other.rank >= mine) return;
    const a = { ...r, rank: other.rank === r.rank ? r.rank - dir : other.rank };
    const b = { ...other, rank: r.rank };
    try {
      await call("update_role", { space: space.id, role: a.id, name: a.name, color: a.color, perms: a.perms, rank: a.rank });
      await call("update_role", { space: space.id, role: b.id, name: b.name, color: b.color, perms: b.perms, rank: b.rank });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <PaneTitle
        title="Roller"
        desc="Üstteki rol alttakinden güçlüdür. Yalnızca kendi rolünün altındakileri düzenleyebilirsin."
        action={
          <Button size="sm" variant="secondary" onClick={() => void create()}>
            <Plus /> Rol
          </Button>
        }
      />
      {roles.length === 0 ? (
        <Empty icon={<Shield className="size-5" />} title="Henüz rol yok" body="Rollerle kimin kanal yöneteceğini, kimin davet edebileceğini belirlersin." />
      ) : (
        <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-4 max-[760px]:grid-cols-1">
          <ul className="flex flex-col gap-px self-start rounded-lg border border-line p-1">
            {roles.map((r, i) => {
              const locked = r.rank >= mine;
              return (
                <li key={r.id} className="group flex items-center">
                  <button
                    onClick={() => setSel(r.id)}
                    aria-current={r.id === sel ? "true" : undefined}
                    className={cn("flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-paper-2", r.id === sel ? "bg-paper-3 text-ink-1" : "text-ink-2")}
                  >
                    <span className="size-2 shrink-0 rounded-full" style={{ background: hex(r.color) }} />
                    <span className="truncate">{r.name}</span>
                    {locked && <Lock className="ml-auto size-3 shrink-0 text-ink-3" aria-label="Senden yüksek" />}
                  </button>
                  {!locked && (
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button aria-label="Yukarı taşı" disabled={i === 0 || roles[i - 1].rank >= mine} onClick={() => void move(r, -1)} className="grid size-5 place-items-center rounded text-ink-3 hover:text-ink-1 disabled:opacity-30">
                        <ArrowUp className="size-3" />
                      </button>
                      <button aria-label="Aşağı taşı" disabled={i === roles.length - 1} onClick={() => void move(r, 1)} className="grid size-5 place-items-center rounded text-ink-3 hover:text-ink-1 disabled:opacity-30">
                        <ArrowDown className="size-3" />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {role && <RoleEditor key={role.id} space={space} role={role} locked={role.rank >= mine} />}
        </div>
      )}
    </>
  );
}

function RoleEditor({ space, role, locked }: { space: SpaceView; role: RoleView; locked: boolean }) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [perms, setPerms] = useState<Perm[]>(role.perms);
  const dirty = name !== role.name || color !== role.color || perms.length !== role.perms.length || perms.some((p) => !role.perms.includes(p));
  const save = useSubmit(() => call("update_role", { space: space.id, role: role.id, name: name.trim() || role.name, color, perms, rank: role.rank }));
  const holders = space.members.filter((m) => m.roles.includes(role.id)).length;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {locked && <p className="rounded-md border border-line bg-paper-2 px-3 py-2 text-xs text-ink-3">Bu rol seninkine eşit ya da daha yüksek; yalnızca görüntüleyebilirsin.</p>}
      {!locked && (
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <ConfirmButton label="Rolü sil" confirm="Silinsin mi?" onConfirm={() => void call("delete_role", { space: space.id, role: role.id }).catch(fail)} />
          <div className="flex-1" />
          {save.error && <span className="text-xs text-danger">{save.error}</span>}
          <Button
            size="sm"
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setName(role.name);
              setColor(role.color);
              setPerms(role.perms);
            }}
          >
            Geri al
          </Button>
          <Button size="sm" disabled={!dirty} aria-busy={save.busy} onClick={() => void save.run()}>
            Değişiklikleri kaydet
          </Button>
        </div>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <Field label="Rol adı">
          <input className="field" value={name} maxLength={32} disabled={locked} onChange={(e) => setName(e.target.value)} />
        </Field>
        <span className="num pb-1.5 text-xs text-ink-3">{holders} üye</span>
      </div>
      <Field label="Renk">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Renk">
          {SWATCHES.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={c === color}
              aria-label={hex(c)}
              disabled={locked}
              onClick={() => setColor(c)}
              className="size-6 rounded-full transition-transform duration-150 hover:scale-110 disabled:hover:scale-100 aria-checked:ring-2 aria-checked:ring-ink-1 aria-checked:ring-offset-2 aria-checked:ring-offset-paper-1"
              style={{ background: hex(c) }}
            />
          ))}
        </div>
      </Field>
      <div>
        <div className="mb-1 text-xs font-medium text-ink-2">İzinler</div>
        <div className="rounded-lg border border-line px-3">
          {PERMS.map((p) => (
            <Row key={p.id} label={p.label} desc={p.desc}>
              <Switch
                checked={perms.includes(p.id)}
                disabled={locked}
                onCheckedChange={(on) => setPerms((cur) => (on ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                aria-label={p.label}
              />
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- invites & bans

function Invites({ space }: { space: SpaceView }) {
  const list = [...space.invites].sort((a, b) => (b.expires ?? Infinity) - (a.expires ?? Infinity));
  return (
    <>
      <PaneTitle title="Davetler" desc="Kod yalnızca oluşturulduğu an gösterilir; kaybolursa yenisini oluştur." />
      <div className="mb-6 rounded-lg border border-line bg-paper-2/40 p-3">
        <InviteCreator compact />
      </div>
      <h3 className="mb-1 text-2xs font-medium tracking-wide text-ink-3 uppercase">Etkin davetler</h3>
      {list.length === 0 ? (
        <p className="py-4 text-xs text-ink-3">Etkin davet yok.</p>
      ) : (
        <div className="rounded-lg border border-line">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_96px_auto] gap-3 border-b border-line px-3 py-1.5 text-2xs text-ink-3">
            <span>Davet</span>
            <span>Oluşturan</span>
            <span className="text-right">Kullanım</span>
            <span>Süre</span>
            <span className="w-[72px]" />
          </div>
          {list.map((inv) => (
            <div key={inv.id} className="grid h-9 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px_96px_auto] items-center gap-3 border-b border-line px-3 last:border-b-0">
              <span className="truncate font-mono text-xs text-ink-2">{shortId(inv.id)}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <Avatar id={inv.created_by} name={nameOf(space, inv.created_by)} size={16} />
                <span className="truncate">{nameOf(space, inv.created_by)}</span>
              </span>
              <span className="num text-right text-xs text-ink-2">
                {inv.uses}
                {inv.max_uses !== null && <span className="text-ink-3"> / {inv.max_uses}</span>}
              </span>
              <span className="num text-xs text-ink-3">{relFuture(inv.expires)}</span>
              <span className="flex w-[72px] justify-end">
                <ConfirmButton label="İptal et" confirm="Emin misin?" onConfirm={() => void call("revoke_invite", { space: space.id, invite: inv.id }).catch(fail)} />
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Bans({ space }: { space: SpaceView }) {
  return (
    <>
      <PaneTitle title="Yasaklılar" desc="Yasaklı kişiler bu halkaya davetle bile katılamaz." />
      {space.bans.length === 0 ? (
        <Empty icon={<Ban className="size-5" />} title="Yasaklı kimse yok" />
      ) : (
        <div className="rounded-lg border border-line">
          {space.bans.map((id) => {
            const m = memberOf(space, id);
            return (
              <div key={id} className="flex h-10 items-center gap-2 border-b border-line px-3 last:border-b-0">
                <Avatar id={id} name={m?.name ?? "?"} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m?.name ?? "Bilinmeyen kişi"}</span>
                  <span className="block font-mono text-2xs text-ink-3">{shortId(id)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void call("ban", { space: space.id, member: id, on: false }).catch(fail)}>
                  Yasağı kaldır
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
