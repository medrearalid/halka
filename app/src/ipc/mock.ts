// In-memory backend for running the UI in a plain browser (`bun run dev`). Loaded only when
// window.__TAURI_INTERNALS__ is absent, via dynamic import, so it never ships in the Tauri hot path.
import type { Backend } from "./index";
import type {
  ChannelView,
  Id,
  MemberView,
  MessageView,
  Perm,
  ProfileView,
  RoleView,
  Settings,
  Snapshot,
  SpaceView,
  UpdateStatus,
} from "./contract";
import { runEncoder, type EncodeLoop } from "@/media/encoder";
import { moveRole } from "@/lib/roleOrder";

const ALL_PERMS: Perm[] = ["admin", "manage_space", "manage_channels", "manage_roles", "manage_messages", "kick", "ban", "invite", "send", "speak", "stream"];
// shortcut: assumes an implicit "everyone" baseline of send/speak/stream; the core decides the real baseline.
const BASE_PERMS: Perm[] = ["send", "speak", "stream"];

function hexId(seed: string): Id {
  let out = "";
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  for (let i = 0; out.length < 64; i++) {
    h = Math.imul(h ^ (i + 0x9e37), 16777619) >>> 0;
    h ^= h >>> 13;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}
let seq = 0;
const newId = () => hexId(`n${Date.now()}${++seq}${Math.random()}`);
const delay = (ms = 60) => new Promise((r) => setTimeout(r, ms + Math.random() * 60));

interface Person {
  id: Id;
  name: string;
  online: boolean;
  conn: MemberView["conn"];
  rtt: number | null;
}
interface MSpace {
  id: Id;
  name: string;
  owner: Id;
  relay_required?: boolean;
  channels: ChannelView[];
  roles: RoleView[];
  members: MemberView[];
  bans: Id[];
  invites: SpaceView["invites"];
}

export function createMockBackend(): Backend {
  const params = new URLSearchParams(location.search);
  const fresh = params.has("onboarding");

  const me: Snapshot["me"] = { id: hexId("me-ada"), name: fresh ? "Anonim" : "Ada", code: "KQ4M-7TXA-P2LD" };
  const people: Person[] = [
    { id: me.id, name: me.name, online: true, conn: "self", rtt: null },
    { id: hexId("deniz"), name: "Deniz", online: true, conn: "direct", rtt: 18 },
    { id: hexId("ece"), name: "Ece Yıldız", online: true, conn: "direct", rtt: 31 },
    { id: hexId("mert"), name: "Mert", online: true, conn: "relay", rtt: 74 },
    { id: hexId("zeynep"), name: "Zeynep", online: true, conn: "direct", rtt: 22 },
    { id: hexId("kaan"), name: "Kaan Aksoy", online: true, conn: "relay", rtt: 96 },
    { id: hexId("selin"), name: "Selin", online: false, conn: "none", rtt: null },
    { id: hexId("burak"), name: "Burak", online: false, conn: "none", rtt: null },
  ];
  const P = Object.fromEntries(people.map((p) => [p.name.split(" ")[0].toLowerCase(), p.id])) as Record<string, Id>;
  const profiles: Snapshot["profiles"] = fresh ? {} : {
    [P.deniz]: { orb_color: 0x70d5bb, bio: "Genellikle akşamları buradayım.", photo: null },
    [P.zeynep]: { orb_color: 0xf2a26d, bio: "", photo: null },
    [P.kaan]: { orb_color: 0x7b9dff, bio: "", photo: null },
  };
  const photos = new Map<Id, string>();

  const mkMember = (id: Id, roles: Id[], owner: Id): MemberView => {
    const p = people.find((x) => x.id === id)!;
    const code = id === me.id ? me.code : id.slice(0, 12).toUpperCase().match(/.{4}/g)!.join("-");
    return { id, name: p.name, code, roles, is_owner: id === owner, online: p.online, conn: p.conn, rtt_ms: p.rtt, voice: null };
  };
  const ch = (name: string, kind: ChannelView["kind"], extra: Partial<ChannelView> = {}): ChannelView => ({
    id: hexId(`ch-${name}-${kind}-${Math.random()}`),
    name,
    kind,
    private_roles: null,
    voice: [],
    streams: [],
    unread: 0,
    ...extra,
  });

  // --- space 1: owned by me
  const r1 = {
    core: { id: hexId("r-core"), name: "Kurucu ekip", color: 0xd9925b, perms: ["admin"] as Perm[], rank: 30 },
    mod: { id: hexId("r-mod"), name: "Moderatör", color: 0x6fb39a, perms: ["manage_messages", "kick", "invite", "manage_channels"] as Perm[], rank: 20 },
    gamer: { id: hexId("r-gamer"), name: "Oyuncu", color: 0x7fa3d6, perms: ["invite"] as Perm[], rank: 10 },
  };
  const s1: MSpace = {
    id: hexId("space-kanka"),
    name: "Kanka Grubu",
    owner: me.id,
    channels: [
      ch("genel", "text"),
      ch("oyun", "text", { unread: 3 }),
      ch("müzik", "text"),
      ch("yönetim", "text", { private_roles: [r1.core.id, r1.mod.id] }),
      ch("Salon", "voice"),
      ch("Oyun odası", "voice"),
    ],
    roles: Object.values(r1),
    members: [],
    bans: [hexId("troll")],
    invites: [
      { id: hexId("inv1"), created_by: me.id, expires: Date.now() + 5 * 86400e3, max_uses: 10, uses: 3 },
      { id: hexId("inv2"), created_by: P.deniz, expires: null, max_uses: null, uses: 12 },
    ],
  };
  s1.members = [
    mkMember(me.id, [], me.id),
    mkMember(P.deniz, [r1.core.id], me.id),
    mkMember(P.ece, [r1.mod.id], me.id),
    mkMember(P.mert, [r1.gamer.id], me.id),
    mkMember(P.zeynep, [r1.gamer.id], me.id),
    mkMember(P.kaan, [], me.id),
    mkMember(P.selin, [r1.mod.id], me.id),
    mkMember(P.burak, [r1.gamer.id], me.id),
  ];
  const salon = s1.channels[4];
  const oyunOdasi = s1.channels[5];
  const putVoice = (sp: MSpace, c: ChannelView, id: Id, extra: Partial<MemberView["voice"] & object> = {}) => {
    const m = sp.members.find((x) => x.id === id)!;
    m.voice = { channel: c.id, muted: false, deafened: false, streaming: false, ...extra };
    c.voice.push(id);
    if (m.voice.streaming) c.streams.push(id);
  };
  putVoice(s1, salon, P.deniz);
  putVoice(s1, salon, P.ece, { muted: true });
  putVoice(s1, salon, P.mert, { streaming: true });
  putVoice(s1, salon, P.zeynep);
  putVoice(s1, oyunOdasi, P.kaan, { deafened: true, muted: true });

  // --- space 2: someone else's, limited perms
  const r2 = { member: { id: hexId("r2-uye"), name: "Üye", color: 0x8fae6b, perms: ["invite"] as Perm[], rank: 5 } };
  const s2: MSpace = {
    id: hexId("space-oyun"),
    name: "Cuma Gecesi",
    owner: P.mert,
    channels: [ch("sohbet", "text", { unread: 12 }), ch("ekran-görüntüleri", "text"), ch("Lobi", "voice")],
    roles: Object.values(r2),
    members: [],
    bans: [],
    invites: [],
  };
  s2.members = [mkMember(me.id, [r2.member.id], P.mert), mkMember(P.mert, [], P.mert), mkMember(P.kaan, [r2.member.id], P.mert), mkMember(P.burak, [], P.mert)];

  const spaces: MSpace[] = fresh ? [] : [s1, s2];
  const activeRelayOnly = localStorage.getItem("halka.mock.relayOnly") === "true";
  let settings: Settings = {
    relay_only: activeRelayOnly,
    relays: [],
    noise_suppression: true,
    echo_cancellation: true,
    push_to_talk: false,
    ptt_key: "KeyV",
    vad_threshold: 0.18,
    spatial_audio: false,
    quick_share_full_screen: false,
  };
  let voice: Snapshot["voice"] = null;
  let pttDown = false;
  let devices = { inputs: ["Mikrofon (Realtek Audio)", "Kulaklık mikrofonu (USB)", "Yayın mikrofonu"], outputs: ["Hoparlör (Realtek Audio)", "Kulaklık (USB)"], input: null as string | null, output: null as string | null };

  // --- messages
  const messages = new Map<Id, MessageView[]>();
  const lines = [
    "akşam kim var?", "ben 9 gibi gelirim", "yeni harita çok iyi olmuş", "bu linke bakın https://example.org/patch-notes",
    "haha aynen", "ses biraz cızırtılıydı az önce", "şimdi düzeldi galiba", "pizza söyleyelim mi", "olur, ben varım",
    "yarın işim var erken kaçarım", "ekranı paylaşsana", "tamam bir saniye", "bu hafta sonu turnuva var mı?",
    "Cumartesi 21:00 diye konuştuk", "relay üzerinden bağlanınca ping biraz artıyor ama sorun yok",
    "kod eşleşiyor, doğrudan bağlıyız 👍", "müzik kanalına yeni liste attım", "biri bana davet kodu atsın",
    "şu bölümü üç kere denedik ya", "bence önce kaynak toplayalım", "tamam o zaman plan bu", "görüşürüz!",
  ];
  const seed = (c: ChannelView, sp: MSpace, n: number) => {
    const out: MessageView[] = [];
    let t = Date.now() - n * 9 * 60_000;
    const authors = sp.members.map((m) => m.id);
    let author = authors[0];
    for (let i = 0; i < n; i++) {
      if (Math.random() < 0.45) author = authors[Math.floor(Math.random() * authors.length)];
      t += Math.random() < 0.7 ? 20_000 + Math.random() * 120_000 : 15 * 60_000 + Math.random() * 3 * 3600e3;
      t = Math.min(t, Date.now() - (n - i) * 15_000);
      const prev = out[out.length - 1];
      out.push({
        id: newId(),
        space: sp.id,
        channel: c.id,
        author,
        ts: Math.round(t),
        text: lines[(i * 7 + n) % lines.length],
        reply_to: prev && Math.random() < 0.08 ? prev.id : null,
        edited: Math.random() < 0.05,
        deleted: false,
      });
    }
    if (out.length > 10) Object.assign(out[out.length - 8], { deleted: true, text: "" });
    messages.set(c.id, out);
  };
  for (const sp of spaces)
    for (const c of sp.channels) if (c.kind === "text") seed(c, sp, c.name === "genel" ? 180 : c.name === "sohbet" ? 60 : 14);

  // --- events
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (name: string, payload: unknown) => listeners.get(name)?.forEach((cb) => cb(payload));
  let snapTimer = 0;
  const changed = () => {
    clearTimeout(snapTimer);
    snapTimer = window.setTimeout(() => emit("snapshot", snapshot()), 30);
  };

  const permsOf = (sp: MSpace): Perm[] => {
    if (sp.owner === me.id) return [...ALL_PERMS];
    const m = sp.members.find((x) => x.id === me.id);
    const set = new Set<Perm>(BASE_PERMS);
    for (const r of sp.roles) if (m?.roles.includes(r.id)) r.perms.forEach((p) => set.add(p));
    if (set.has("admin")) return [...ALL_PERMS];
    return [...set];
  };
  const snapshot = (): Snapshot => ({
    active_relay_only: activeRelayOnly,
    me: { ...me },
    profiles: structuredClone(profiles),
    spaces: spaces.map((sp) => ({
      ...structuredClone(sp),
      relay_required: !!sp.relay_required,
      my_perms: permsOf(sp),
      channels: structuredClone(sp.channels),
    })),
    settings: { ...settings, relays: [...settings.relays] },
    voice: voice && { ...voice },
    online: true,
  });

  const sp = (id: Id) => {
    const s = spaces.find((x) => x.id === id);
    if (!s) throw "Halka bulunamadı";
    return s;
  };
  const need = (s: MSpace, p: Perm) => {
    const perms = permsOf(s);
    if (!perms.includes(p) && !perms.includes("admin")) throw "Bunun için yetkin yok";
  };
  const findMsg = (id: Id) => {
    for (const list of messages.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    throw "Mesaj bulunamadı";
  };

  // --- voice simulation
  let levelTimer = 0;
  const talk = new Map<Id, { on: boolean; phase: number }>();
  const tickLevels = () => {
    if (!voice) return;
    const s = spaces.find((x) => x.id === voice!.space);
    const c = s?.channels.find((x) => x.id === voice!.channel);
    if (!s || !c) return;
    const t = performance.now() / 1000;
    const out: Record<Id, number> = {};
    for (const id of c.voice) {
      let st = talk.get(id);
      if (!st) talk.set(id, (st = { on: false, phase: Math.random() * 10 }));
      if (Math.random() < (st.on ? 0.03 : 0.012)) st.on = !st.on;
      const m = s.members.find((x) => x.id === id);
      const muted = id === me.id ? voice.muted || (settings.push_to_talk && !pttDown) : m?.voice?.muted;
      const env = 0.5 + 0.5 * Math.sin(t * 7.3 + st.phase) * Math.sin(t * 2.1 + st.phase * 2);
      out[id] = muted ? 0 : st.on ? 0.25 + 0.65 * Math.abs(env) * (0.7 + 0.3 * Math.random()) : 0.015 * Math.random();
    }
    emit("levels", out);
  };
  const setMyVoice = () => {
    for (const s of spaces) {
      const m = s.members.find((x) => x.id === me.id);
      if (!m) continue;
      for (const c of s.channels) {
        c.voice = c.voice.filter((x) => x !== me.id);
        c.streams = c.streams.filter((x) => x !== me.id);
      }
      m.voice = null;
      if (voice && voice.space === s.id) {
        const c = s.channels.find((x) => x.id === voice!.channel)!;
        m.voice = { channel: c.id, muted: voice.muted, deafened: voice.deafened, streaming: myStreaming };
        c.voice.push(me.id);
        if (myStreaming) c.streams.push(me.id);
      }
    }
    clearInterval(levelTimer);
    if (voice) levelTimer = window.setInterval(tickLevels, 50);
    changed();
  };
  let myStreaming = false;
  let updateStatus: UpdateStatus = { state: "idle" };
  const setUpdate = (u: UpdateStatus) => emit("update", (updateStatus = u));

  // --- fake screen streams for `watch`
  const watching = new Map<Id, { loop: EncodeLoop; stop: () => void }>();
  const fakeStream = (member: Id, deliver: (b: ArrayBuffer) => void) => {
    const W = 1280, H = 720;
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext("2d")!;
    const name = people.find((p) => p.id === member)?.name ?? "?";
    let n = 0;
    let timer = 0;
    const draw = (t: number) => {
      g.fillStyle = "#16171a";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#1f2125";
      g.fillRect(0, 0, 220, H);
      g.fillRect(0, 0, W, 36);
      g.fillStyle = "#c58c5c";
      g.fillRect(16, 12, 80, 12);
      const scroll = (t * 40) % 24;
      for (let i = 0; i < 32; i++) {
        const y = 60 + i * 24 - scroll;
        const w = 80 + ((i * 97) % 380);
        g.fillStyle = ["#8fb3d9", "#d9a56f", "#9bc29a", "#c9c3b8"][i % 4];
        g.globalAlpha = 0.75;
        g.fillRect(260 + ((i * 3) % 5) * 24, y, w, 10);
        g.fillRect(260 + w + 40, y, 120 - ((i * 13) % 90), 10);
        g.globalAlpha = 1;
      }
      for (let i = 0; i < 14; i++) {
        g.fillStyle = i === 3 ? "#2c2e33" : "#1f2125";
        g.fillRect(12, 56 + i * 30, 196, 24);
        g.fillStyle = "#6d6a64";
        g.fillRect(24, 64 + i * 30, 60 + ((i * 31) % 100), 8);
      }
      const bx = 860 + Math.sin(t * 0.8) * 120, by = 380 + Math.cos(t * 1.1) * 120;
      g.strokeStyle = "#c58c5c";
      g.lineWidth = 6;
      g.beginPath();
      g.arc(bx, by, 70, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "#e8e4dc";
      g.font = "600 28px system-ui, sans-serif";
      g.fillText(`${name} · ekran`, W - 300, H - 40);
      g.font = "500 18px ui-monospace, monospace";
      g.fillText(new Date().toLocaleTimeString("tr-TR"), W - 300, H - 70);
    };
    const t0 = performance.now();
    const frames = new ReadableStream<VideoFrame>({
      start(ctrl) {
        timer = window.setInterval(() => {
          const t = (performance.now() - t0) / 1000;
          draw(t);
          try {
            ctrl.enqueue(new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) }));
          } catch {
            clearInterval(timer);
          }
          n++;
        }, 1000 / 30);
      },
      cancel() {
        clearInterval(timer);
      },
    }, { highWaterMark: 1 });
    const loop = runEncoder(frames, deliver, (msg) => emit("notice", { kind: "error", text: msg }), 30);
    return { loop, stop: () => { clearInterval(timer); loop.stop(); } };
  };

  // --- ambient chatter: someone posts every ~25 s
  if (!fresh)
    setInterval(() => {
      const s = s1;
      const c = Math.random() < 0.6 ? s.channels[0] : s.channels[1];
      const others = s.members.filter((m) => m.id !== me.id && m.online);
      const author = others[Math.floor(Math.random() * others.length)];
      const m: MessageView = { id: newId(), space: s.id, channel: c.id, author: author.id, ts: Date.now(), text: lines[Math.floor(Math.random() * lines.length)], reply_to: null, edited: false, deleted: false };
      messages.get(c.id)!.push(m);
      c.unread++;
      emit("message", m);
      changed();
    }, 25_000);

  const commands: Record<string, (a: any) => unknown> = {
    snapshot: () => snapshot(),
    set_name: ({ name }) => {
      const n = String(name).trim().slice(0, 32);
      if (!n) throw "İsim boş olamaz";
      me.name = n;
      people[0].name = n;
      for (const s of spaces) {
        const m = s.members.find((x) => x.id === me.id);
        if (m) m.name = n;
      }
      changed();
    },
    update_profile: ({ name, orbColor, bio, photo }) => {
      const about = String(bio).trim();
      if (Array.from(about).length > 160) throw "Biyografi en fazla 160 karakter olabilir";
      if (!Number.isInteger(orbColor) || orbColor < 0 || orbColor > 0xffffff) throw "Geçersiz orb rengi";
      if (photo.kind === "replace" && atob(photo.data).length > 32 * 1024) throw "Profil fotoğrafı çok büyük";
      commands.set_name({ name });
      const profile: ProfileView = { orb_color: orbColor, bio: about, photo: profiles[me.id]?.photo ?? null };
      if (photo.kind === "replace") {
        profile.photo = hexId(photo.data);
        photos.set(me.id, photo.data);
      } else if (photo.kind === "remove") {
        profile.photo = null;
        photos.delete(me.id);
      }
      profiles[me.id] = profile;
    },
    profile_photo: ({ member, hash }) => {
      const photo = photos.get(member);
      if (!photo || profiles[member]?.photo !== hash) throw "Profil fotoğrafı bulunamadı";
      return photo;
    },
    create_space: ({ name, relayRequired }) => {
      const s: MSpace = {
        id: newId(), name: String(name).trim() || "Yeni halka", owner: me.id, relay_required: !!relayRequired,
        channels: [ch("genel", "text"), ch("Salon", "voice")], roles: [], members: [mkMember(me.id, [], me.id)], bans: [], invites: [],
      };
      s.members[0].is_owner = true;
      spaces.push(s);
      messages.set(s.channels[0].id, []);
      changed();
      return s.id;
    },
    join_space: async ({ code }) => {
      await delay(700);
      if (!/^halka:[0-9A-Za-z_-]{8,}$/.test(String(code).trim())) throw "Geçersiz davet kodu";
      const s: MSpace = {
        id: newId(), name: "Mahalle", owner: P.burak, channels: [ch("genel", "text"), ch("Oda", "voice")], roles: [],
        members: [mkMember(me.id, [], P.burak), mkMember(P.burak, [], P.burak)], bans: [], invites: [],
      };
      spaces.push(s);
      seed(s.channels[0], s, 6);
      changed();
      return s.id;
    },
    leave_space: ({ space }) => {
      const i = spaces.findIndex((x) => x.id === space);
      if (i >= 0) spaces.splice(i, 1);
      if (voice?.space === space) voice = null;
      setMyVoice();
    },
    delete_space: ({ space }) => {
      const s = sp(space);
      if (s.owner !== me.id) throw "Halkayı yalnızca kurucu silebilir";
      spaces.splice(spaces.indexOf(s), 1);
      if (voice?.space === space) voice = null;
      setMyVoice();
      emit("notice", { kind: "info", text: `“${s.name}” halkası silindi.` });
    },
    require_relay: ({ space }) => {
      const s = sp(space);
      if (s.owner !== me.id) throw "Bunu yalnızca kurucu yapabilir";
      s.relay_required = true;
      s.invites = [];
      changed();
    },
    rename_space: ({ space, name }) => {
      const s = sp(space);
      need(s, "manage_space");
      s.name = String(name).trim() || s.name;
      changed();
    },
    create_invite: ({ space, expiresInMs, maxUses }) => {
      const s = sp(space);
      need(s, "invite");
      const id = newId();
      s.invites.push({ id, created_by: me.id, expires: expiresInMs === null ? null : Date.now() + expiresInMs, max_uses: maxUses, uses: 0 });
      changed();
      return `halka:${id.slice(0, 40)}`;
    },
    revoke_invite: ({ space, invite }) => {
      const s = sp(space);
      s.invites = s.invites.filter((x) => x.id !== invite);
      changed();
    },
    create_channel: ({ space, name, kind, privateRoles }) => {
      const s = sp(space);
      need(s, "manage_channels");
      const c = ch(String(name).trim(), kind, { private_roles: privateRoles });
      s.channels.push(c);
      if (kind === "text") messages.set(c.id, []);
      changed();
      return c.id;
    },
    update_channel: ({ space, channel, name, privateRoles }) => {
      const s = sp(space);
      need(s, "manage_channels");
      const c = s.channels.find((x) => x.id === channel);
      if (!c) throw "Kanal bulunamadı";
      c.name = String(name).trim() || c.name;
      c.private_roles = privateRoles;
      changed();
    },
    delete_channel: ({ space, channel }) => {
      const s = sp(space);
      need(s, "manage_channels");
      s.channels = s.channels.filter((x) => x.id !== channel);
      if (voice?.channel === channel) voice = null;
      setMyVoice();
    },
    create_role: ({ space, name, color, perms, rank }) => {
      const s = sp(space);
      need(s, "manage_roles");
      const id = newId();
      s.roles.push({ id, name, color, perms, rank });
      changed();
      return id;
    },
    update_role: ({ space, role, name, color, perms, rank }) => {
      const s = sp(space);
      need(s, "manage_roles");
      const r = s.roles.find((x) => x.id === role);
      if (!r) throw "Rol bulunamadı";
      Object.assign(r, { name, color, perms, rank });
      changed();
    },
    move_role: ({ space, role, target }) => {
      const s = sp(space);
      if (s.owner !== me.id) throw "Rol sırasını yalnızca kurucu değiştirebilir";
      const roles = moveRole(s.roles, space, role, target);
      if (!roles) throw "Geçersiz rol sırası";
      s.roles = roles;
      changed();
    },
    delete_role: ({ space, role }) => {
      const s = sp(space);
      need(s, "manage_roles");
      s.roles = s.roles.filter((x) => x.id !== role);
      for (const m of s.members) m.roles = m.roles.filter((x) => x !== role);
      changed();
    },
    assign_role: ({ space, member, role, on }) => {
      const s = sp(space);
      need(s, "manage_roles");
      const m = s.members.find((x) => x.id === member);
      if (!m) throw "Üye bulunamadı";
      m.roles = on ? [...new Set([...m.roles, role])] : m.roles.filter((x) => x !== role);
      changed();
    },
    kick: ({ space, member }) => {
      const s = sp(space);
      need(s, "kick");
      s.members = s.members.filter((x) => x.id !== member);
      for (const c of s.channels) c.voice = c.voice.filter((x) => x !== member);
      emit("notice", { kind: "info", text: "Üye halkadan çıkarıldı" });
      changed();
    },
    ban: ({ space, member, on }) => {
      const s = sp(space);
      need(s, "ban");
      if (on) {
        s.bans.push(member);
        s.members = s.members.filter((x) => x.id !== member);
        for (const c of s.channels) c.voice = c.voice.filter((x) => x !== member);
      } else s.bans = s.bans.filter((x) => x !== member);
      changed();
    },
    messages: async ({ space, channel, before, limit }) => {
      await delay(before === null ? 120 : 380);
      const s = sp(space);
      const c = s.channels.find((x) => x.id === channel);
      if (!c) throw "Kanal bulunamadı";
      const all = messages.get(channel) ?? [];
      const older = before === null ? all : all.filter((m) => m.ts < before);
      if (c.unread) {
        c.unread = 0;
        changed();
      }
      return structuredClone(older.slice(-limit));
    },
    send_message: ({ space, channel, text, replyTo }) => {
      const s = sp(space);
      need(s, "send");
      if (!s.channels.some((c) => c.id === channel)) throw "Kanal bulunamadı";
      const t = String(text);
      if (!t.trim() || t.length > 4000) throw "Mesaj boş ya da çok uzun";
      const m: MessageView = { id: newId(), space: s.id, channel, author: me.id, ts: Date.now(), text: t, reply_to: replyTo, edited: false, deleted: false };
      const list = messages.get(channel) ?? [];
      list.push(m);
      messages.set(channel, list);
      setTimeout(() => emit("message", m), 40);
      return m.id;
    },
    edit_message: ({ message, text }) => {
      const m = findMsg(message);
      if (m.author !== me.id) throw "Yalnızca kendi mesajını düzenleyebilirsin";
      Object.assign(m, { text, edited: true });
      emit("message", { ...m });
    },
    delete_message: ({ space, message }) => {
      const m = findMsg(message);
      if (m.author !== me.id) need(sp(space), "manage_messages");
      Object.assign(m, { text: "", deleted: true });
      emit("message", { ...m });
    },
    voice_join: async ({ space, channel }) => {
      await delay(250);
      const s = sp(space);
      need(s, "speak");
      myStreaming = false;
      voice = { space: s.id, channel, muted: false, deafened: false };
      setMyVoice();
    },
    voice_leave: () => {
      voice = null;
      myStreaming = false;
      setMyVoice();
    },
    set_muted: ({ muted }) => {
      if (voice) voice.muted = muted;
      setMyVoice();
    },
    set_deafened: ({ deafened }) => {
      if (voice) voice.deafened = deafened;
      setMyVoice();
    },
    set_ptt: ({ down }) => void (pttDown = down),
    set_peer_volume: () => {},
    mic_test: () => undefined,
    audio_devices: () => structuredClone(devices),
    set_audio_devices: ({ input, output }) => void (devices = { ...devices, input, output }),
    get_settings: () => ({ ...settings }),
    set_settings: ({ settings: s }) => {
      localStorage.setItem("halka.mock.relayOnly", String(s.relay_only));
      settings = { ...s };
      changed();
    },
    stream_start: () => {
      if (!voice) throw "Önce bir ses odasına katıl";
      myStreaming = true;
      setMyVoice();
    },
    stream_packet: () => {},
    stream_stop: () => {
      myStreaming = false;
      setMyVoice();
    },
    watch: ({ member, channel }) => {
      watching.get(member)?.stop();
      const sink = channel as { onmessage?: (b: ArrayBuffer) => void };
      if (typeof VideoEncoder === "undefined") throw "Bu tarayıcıda WebCodecs yok";
      watching.set(member, fakeStream(member, (b) => sink.onmessage?.(b)));
    },
    unwatch: ({ member }) => {
      watching.get(member)?.stop();
      watching.delete(member);
    },
    update_status: () => updateStatus,
    // fake run: check, download in ~4 s, then ready; ?update=error fails instead
    update_retry: () => {
      const fail = new URLSearchParams(location.search).get("update") === "error";
      setUpdate({ state: "checking" });
      let pct = 0;
      const t = window.setInterval(() => {
        pct += 7;
        if (fail && pct > 40) {
          clearInterval(t);
          setUpdate({ state: "error", message: "Güncelleme sunucusuna ulaşılamadı", detail: "error sending request for url (mock)" });
        } else if (pct >= 100) {
          clearInterval(t);
          setUpdate({ state: "ready", version: "9.9.9" });
        } else setUpdate({ state: "downloading", version: "9.9.9", pct });
      }, 250);
    },
    update_restart_now: () => location.reload(),
    restart_app: ({ resume }) => {
      sessionStorage.setItem("halka.mock.resume", resume);
      location.reload();
    },
    take_resume: () => {
      const r = sessionStorage.getItem("halka.mock.resume");
      sessionStorage.removeItem("halka.mock.resume");
      return r;
    },
  };

  return {
    async invoke(name, args) {
      const fn = commands[name];
      if (!fn) throw `Bilinmeyen komut: ${name}`;
      await delay(15);
      return await fn(args ?? {});
    },
    async listen(name, cb) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    channel(onmessage) {
      return { onmessage };
    },
  };
}
