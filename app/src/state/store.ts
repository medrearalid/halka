import { create } from "zustand";
import { call, errText, on, type Id, type MessageView, type Snapshot } from "@/ipc";
import { peerCue, playStatusSound, statusCue, stopStatusSound } from "@/lib/statusSounds";

export interface ChannelMsgs {
  items: MessageView[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

export type DialogKind = "app-settings" | "space-settings" | "invite" | "create-space" | "join-space" | "create-channel" | "share";

interface Persisted {
  space: Id | null;
  lastChannel: Record<Id, Id>;
  membersOpen: boolean;
  peerVolume: Record<Id, number>;
  statusSounds: boolean;
}

interface AppState extends Persisted {
  welcome: boolean;
  snap: Snapshot | null;
  bootError: string | null;
  channel: Id | null;
  msgs: Record<Id, ChannelMsgs>;
  /** Download progress by file hash (have === size: ready; size 0: failed). */
  fileProgress: Record<Id, { have: number; size: number }>;
  toasts: Toast[];
  localStream: MediaStream | null;
  nativeShare: boolean;
  watchFullscreen: Id | null;
  dialog: { kind: DialogKind; tab?: string } | { kind: "profile"; member: Id; space: Id | null; trigger: HTMLElement | null } | null;
  palette: boolean;
  voiceChatOpen: boolean;

  select(space: Id, channel?: Id | null): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;
  openDialog(kind: DialogKind, tab?: string): void;
  openProfile(member: Id, space?: Id | null, trigger?: HTMLElement): void;
  closeDialog(): void;
  setMembersOpen(v: boolean): void;
  setPalette(v: boolean): void;
  setVoiceChatOpen(v: boolean): void;
  setStatusSounds(v: boolean): void;
  setPeerVolume(member: Id, v: number): void;
  loadMessages(space: Id, channel: Id, older?: boolean): Promise<void>;
  trimMessages(channel: Id, keep: number): void;
}

const KEY = "halka.ui.v1";
const PAGE = 50;

function readPersisted(): Persisted {
  const d: Persisted = { space: null, lastChannel: {}, membersOpen: window.innerWidth >= 1100, peerVolume: {}, statusSounds: true };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Persisted>) };
  } catch {
    return d;
  }
}

export const emptyMsgs: ChannelMsgs = { items: [], hasMore: true, loading: false, loaded: false, error: null };
let toastSeq = 0;

function mergeMessages(a: MessageView[], b: MessageView[]): MessageView[] {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
}

export const useApp = create<AppState>()((set, get) => ({
  ...readPersisted(),
  welcome: true,
  snap: null,
  bootError: null,
  channel: null,
  msgs: {},
  fileProgress: {},
  toasts: [],
  localStream: null,
  nativeShare: false,
  watchFullscreen: null,
  dialog: null,
  palette: false,
  voiceChatOpen: true,

  select(space, channel) {
    pending = { space, channel: channel ?? null, until: Date.now() + 5000 };
    const lastChannel = channel ? { ...get().lastChannel, [space]: channel } : get().lastChannel;
    set({ space, channel: channel ?? lastChannel[space] ?? null, lastChannel, watchFullscreen: null, welcome: false });
    reconcile();
  },
  toast(kind, text) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  openDialog(kind, tab) {
    set({ dialog: { kind, tab }, palette: false });
  },
  openProfile(member, space = get().space, trigger) {
    const active = document.activeElement;
    set({ dialog: { kind: "profile", member, space, trigger: trigger ?? (active instanceof HTMLElement ? active : null) }, palette: false });
  },
  closeDialog() {
    set({ dialog: null });
  },
  setMembersOpen(membersOpen) {
    set({ membersOpen });
  },
  setPalette(palette) {
    set({ palette });
  },
  setVoiceChatOpen(voiceChatOpen) {
    set({ voiceChatOpen });
  },
  setStatusSounds(statusSounds) {
    if (!statusSounds) stopStatusSound();
    set({ statusSounds });
  },
  setPeerVolume(member, v) {
    set((s) => ({ peerVolume: { ...s.peerVolume, [member]: v } }));
    void call("set_peer_volume", { member, volume: v }).catch((e) => get().toast("error", errText(e)));
  },
  async loadMessages(space, channel, older = false) {
    const cur = get().msgs[channel] ?? emptyMsgs;
    if (cur.loading || (older && !cur.hasMore)) return;
    const patch = (p: Partial<ChannelMsgs>) =>
      set((s) => ({ msgs: { ...s.msgs, [channel]: { ...(s.msgs[channel] ?? emptyMsgs), ...p } } }));
    patch({ loading: true, error: null });
    try {
      const before = older ? (cur.items[0]?.ts ?? null) : null;
      const page = await call("messages", { space, channel, before, limit: PAGE });
      const prev = get().msgs[channel] ?? emptyMsgs;
      patch({
        items: mergeMessages(prev.items, page),
        hasMore: older || !prev.loaded ? page.length >= PAGE : prev.hasMore,
        loading: false,
        loaded: true,
      });
    } catch (e) {
      patch({ loading: false, loaded: true, error: errText(e) });
    }
  },
  trimMessages(channel, keep) {
    const cur = get().msgs[channel];
    if (!cur || cur.items.length <= keep) return;
    set((s) => ({ msgs: { ...s.msgs, [channel]: { ...cur, items: cur.items.slice(-keep), hasMore: true } } }));
  },
}));

/** A just-created space/channel may be selected before a snapshot contains it. */
let pending: { space: Id; channel: Id | null; until: number } | null = null;

/** Keep the selection valid against the latest snapshot. */
function reconcile() {
  const s = useApp.getState();
  const snap = s.snap;
  if (!snap) return;
  if (s.welcome) return;
  if (pending) {
    const sp = snap.spaces.find((x) => x.id === pending!.space);
    const arrived = sp && (!pending.channel || sp.channels.some((c) => c.id === pending!.channel));
    if (!arrived && Date.now() < pending.until) return;
    pending = null;
  }
  const space = snap.spaces.find((x) => x.id === s.space) ?? snap.spaces[0];
  if (!space) {
    useApp.setState({ space: null, channel: null, welcome: true });
    return;
  }
  let ch = space.channels.find((c) => c.id === s.channel);
  if (!ch) ch = space.channels.find((c) => c.id === s.lastChannel[space.id]);
  if (!ch) ch = space.channels.find((c) => c.kind === "text") ?? space.channels[0];
  if (space.id !== s.space || (ch?.id ?? null) !== s.channel) useApp.setState({ space: space.id, channel: ch?.id ?? null });
}

useApp.subscribe((s, p) => {
  if (s.space === p.space && s.lastChannel === p.lastChannel && s.membersOpen === p.membersOpen && s.peerVolume === p.peerVolume && s.statusSounds === p.statusSounds)
    return;
  try {
    const v: Persisted = { space: s.space, lastChannel: s.lastChannel, membersOpen: s.membersOpen, peerVolume: s.peerVolume, statusSounds: s.statusSounds };
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
});

let readTimer = 0;

function visibleChat(s: AppState) {
  if (s.welcome) return;
  const ch = s.snap?.spaces.find((x) => x.id === s.space)?.channels.find((c) => c.id === s.channel);
  return ch?.kind === "voice" && !s.voiceChatOpen ? undefined : ch;
}

/** `messages` marks a channel read; ping it when a message lands in the channel on screen. */
function markReadSoon(space: Id, channel: Id) {
  clearTimeout(readTimer);
  readTimer = window.setTimeout(() => {
    const s = useApp.getState();
    if (s.space === space && visibleChat(s)?.id === channel && document.hasFocus())
      void call("messages", { space, channel, before: null, limit: 1 }).catch(() => {});
  }, 600);
}

function applySnapshot(snap: Snapshot) {
  const previous = useApp.getState();
  const cue = previous.statusSounds && !previous.welcome ? statusCue(previous.snap, snap) ?? peerCue(previous.snap, snap) : undefined;
  const voice = snap.voice;
  const watching = previous.watchFullscreen;
  const stillWatching = watching && voice && snap.spaces.find((space) => space.id === voice.space)
    ?.channels.find((channel) => channel.id === voice.channel)?.streams.includes(watching);
  useApp.setState({ snap, watchFullscreen: stillWatching ? watching : null });
  reconcile();
  if (cue) void playStatusSound(cue);
}

export async function boot() {
  on("snapshot", applySnapshot);
  on("message", (m) => {
    const s = useApp.getState();
    const cur = s.msgs[m.channel];
    if (cur?.loaded) {
      useApp.setState({ msgs: { ...s.msgs, [m.channel]: { ...cur, items: mergeMessages(cur.items, [m]) } } });
    }
    if (m.channel === visibleChat(s)?.id && document.hasFocus()) markReadSoon(m.space, m.channel);
  });
  on("removed", (gone) => {
    const s = useApp.getState();
    const msgs = { ...s.msgs };
    for (const g of gone) {
      const cur = msgs[g.channel];
      if (cur) msgs[g.channel] = { ...cur, items: cur.items.filter((m) => m.id !== g.id) };
    }
    useApp.setState({ msgs });
  });
  on("file_progress", (p) =>
    useApp.setState((s) => ({ fileProgress: { ...s.fileProgress, [p.hash]: { have: p.have, size: p.size } } })),
  );
  on("notice", (n) => useApp.getState().toast(n.kind, n.text));
  window.addEventListener("focus", () => {
    const s = useApp.getState();
    const ch = visibleChat(s);
    if (s.space && ch && ch.unread > 0) markReadSoon(s.space, ch.id);
  });
  try {
    const snap = await call("snapshot");
    if (!useApp.getState().snap) applySnapshot(snap);
    // the core does not report peer volumes back; replay what this device remembers
    for (const [member, volume] of Object.entries(useApp.getState().peerVolume))
      if (volume !== 1) void call("set_peer_volume", { member, volume }).catch(() => {});
  } catch (e) {
    useApp.setState({ bootError: errText(e) });
  }
}
