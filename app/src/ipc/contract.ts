// IPC contract between the Rust core (app/src-tauri) and the web UI.
// Source of truth for both sides. Rust mirrors these shapes in crates/core/src/api.rs
// (serde, snake_case fields). Tauri command *argument* names are camelCase on the JS side.

export type Id = string; // lowercase hex of a 32-byte key or hash

export type Perm =
  | "admin" // everything below, bypasses channel privacy
  | "manage_space" // rename space
  | "manage_channels"
  | "manage_roles" // create/edit/assign roles ranked below own highest role
  | "manage_messages" // delete others' messages
  | "kick"
  | "ban"
  | "invite"
  | "send" // text chat
  | "speak" // voice
  | "stream"; // screen share

export interface Me {
  id: Id;
  name: string;
  /** Short, human-comparable safety code derived from the public key, e.g. "KQ4M-7TXA-P2LD". */
  code: string;
}

export type ChannelKind = "text" | "voice";

export interface ChannelView {
  id: Id;
  name: string;
  kind: ChannelKind;
  /** null = visible to everyone; otherwise only these roles (+ admins/owner). */
  private_roles: Id[] | null;
  /** Member ids currently connected to this voice channel (voice channels only). */
  voice: Id[];
  /** Member ids currently screen-sharing in this voice channel. */
  streams: Id[];
  unread: number;
}

export interface RoleView {
  id: Id;
  name: string;
  /** 0xRRGGBB */
  color: number;
  perms: Perm[];
  /** Higher rank outranks lower. Owner is above every role. */
  rank: number;
}

export type ConnKind = "self" | "direct" | "relay" | "none";

export interface VoiceState {
  channel: Id;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
}

export interface MemberView {
  id: Id;
  name: string;
  code: string;
  roles: Id[];
  is_owner: boolean;
  online: boolean;
  conn: ConnKind;
  rtt_ms: number | null;
  voice: VoiceState | null;
}

export interface InviteView {
  /** invite public key */
  id: Id;
  created_by: Id;
  /** unix ms, null = never */
  expires: number | null;
  max_uses: number | null;
  uses: number;
}

export interface SpaceView {
  id: Id;
  name: string;
  owner: Id;
  /** Effective space-level permissions of the local user. */
  my_perms: Perm[];
  channels: ChannelView[];
  roles: RoleView[];
  members: MemberView[];
  bans: Id[];
  invites: InviteView[];
}

export interface MessageView {
  id: Id;
  space: Id;
  channel: Id;
  author: Id;
  /** unix ms (author clock) */
  ts: number;
  text: string;
  reply_to: Id | null;
  edited: boolean;
  deleted: boolean;
}

export interface AudioDevices {
  inputs: string[];
  outputs: string[];
  input: string | null; // null = system default
  output: string | null;
}

export interface Settings {
  /** Hide your IP from peers: only connect through relays. Requires restart. */
  relay_only: boolean;
  /** Custom relay URLs; empty = built-in public relays. Requires restart. */
  relays: string[];
  noise_suppression: boolean;
  echo_cancellation: boolean;
  /** Push-to-talk instead of voice activity. */
  push_to_talk: boolean;
  /** KeyboardEvent.code, e.g. "KeyV" (used while window focused) */
  ptt_key: string;
  /** 0..1 voice-activity threshold */
  vad_threshold: number;
  /** Hear people from the side of the ring they sit on. */
  spatial_audio: boolean;
}

export interface Snapshot {
  me: Me;
  profiles: Record<Id, ProfileView | undefined>;
  spaces: SpaceView[];
  settings: Settings;
  /** the voice channel we're in, if any */
  voice: { space: Id; channel: Id; muted: boolean; deafened: boolean } | null;
  /** true once the network endpoint is up */
  online: boolean;
}

export interface ProfileView {
  orb_color: number;
  bio: string;
  photo: Id | null;
}

export type PhotoEdit = { kind: "keep" | "remove" } | { kind: "replace"; data: string };

// ---------------------------------------------------------------- commands
// invoke<Ret>(name, args). All commands reject with a human-readable string on error.
export interface Commands {
  snapshot: { args: {}; ret: Snapshot };
  set_name: { args: { name: string }; ret: void };
  update_profile: { args: { name: string; orbColor: number; bio: string; photo: PhotoEdit }; ret: void };
  profile_photo: { args: { member: Id; hash: Id }; ret: string };

  create_space: { args: { name: string }; ret: Id };
  /** Accepts a "halka:…" invite code. Resolves with the space id once joined. */
  join_space: { args: { code: string }; ret: Id };
  leave_space: { args: { space: Id }; ret: void };
  rename_space: { args: { space: Id; name: string }; ret: void };
  /** expiresInMs/maxUses null = unlimited. Returns the shareable code. */
  create_invite: {
    args: { space: Id; expiresInMs: number | null; maxUses: number | null };
    ret: string;
  };
  revoke_invite: { args: { space: Id; invite: Id }; ret: void };

  create_channel: {
    args: { space: Id; name: string; kind: ChannelKind; privateRoles: Id[] | null };
    ret: Id;
  };
  update_channel: {
    args: { space: Id; channel: Id; name: string; privateRoles: Id[] | null };
    ret: void;
  };
  delete_channel: { args: { space: Id; channel: Id }; ret: void };

  create_role: {
    args: { space: Id; name: string; color: number; perms: Perm[]; rank: number };
    ret: Id;
  };
  update_role: {
    args: { space: Id; role: Id; name: string; color: number; perms: Perm[]; rank: number };
    ret: void;
  };
  delete_role: { args: { space: Id; role: Id }; ret: void };
  assign_role: { args: { space: Id; member: Id; role: Id; on: boolean }; ret: void };
  kick: { args: { space: Id; member: Id }; ret: void };
  ban: { args: { space: Id; member: Id; on: boolean }; ret: void };

  /** Newest-last page of messages older than `before` (unix ms, null = latest). Marks channel read. */
  messages: {
    args: { space: Id; channel: Id; before: number | null; limit: number };
    ret: MessageView[];
  };
  send_message: {
    args: { space: Id; channel: Id; text: string; replyTo: Id | null };
    ret: Id;
  };
  edit_message: { args: { space: Id; message: Id; text: string }; ret: void };
  delete_message: { args: { space: Id; message: Id }; ret: void };

  voice_join: { args: { space: Id; channel: Id }; ret: void };
  voice_leave: { args: {}; ret: void };
  set_muted: { args: { muted: boolean }; ret: void };
  set_deafened: { args: { deafened: boolean }; ret: void };
  /** Push-to-talk key state (only meaningful when settings.push_to_talk). */
  set_ptt: { args: { down: boolean }; ret: void };
  /** 0..2, 1 = unchanged */
  set_peer_volume: { args: { member: Id; volume: number }; ret: void };
  /** Local microphone test outside a room: feeds `levels` for self, sends nothing. */
  mic_test: { args: { on: boolean }; ret: void };
  audio_devices: { args: {}; ret: AudioDevices };
  set_audio_devices: { args: { input: string | null; output: string | null }; ret: void };

  get_settings: { args: {}; ret: Settings };
  set_settings: { args: { settings: Settings }; ret: void };

  // ---- screen share (see "Stream wire format" below)
  capture_sources: { args: {}; ret: CaptureSource[] };
  capture_start: { args: { id: string; source: string; preset: string; preview: unknown }; ret: void };
  capture_stop: { args: { id: string }; ret: void };
  capture_preview: { args: { id: string; enabled: boolean }; ret: void };
  /** Announce we're sharing in our current voice channel. */
  stream_start: { args: {}; ret: void };
  /** Body is a raw ArrayBuffer packet (NOT json): invoke("stream_packet", packet). */
  stream_packet: { args: ArrayBuffer; ret: void };
  stream_stop: { args: {}; ret: void };
  /** Start receiving a member's stream; packets arrive on `channel` (tauri Channel<ArrayBuffer>). */
  watch: { args: { member: Id; channel: unknown }; ret: void };
  unwatch: { args: { member: Id }; ret: void };
}

// ---------------------------------------------------------------- events
// listen(name, e => e.payload)
export interface Events {
  /** Full state; emitted on any change (debounced). */
  snapshot: Snapshot;
  /** New, edited or deleted message (deleted => text ""). */
  message: MessageView;
  /** Voice levels 0..1 by member id (incl. self), ~20 Hz while in a voice channel. */
  levels: Record<Id, number>;
  /** Transient notice for the user. */
  notice: { kind: "info" | "error"; text: string };
  /** A watched stream ended. */
  stream_ended: { member: Id };
  capture_ended: { id: string; error: string | null };
}

export interface CaptureSource {
  id: string;
  kind: "monitor" | "window";
  title: string;
  width: number;
  height: number;
  fps: number;
}

// ---------------------------------------------------------------- stream wire format
// Every packet (both directions) is:
//   byte 0      : kind  0 = config (payload = UTF-8 JSON StreamConfig)
//                       1 = key frame chunk, 2 = delta frame chunk
//   bytes 1..9  : u64 little-endian timestamp in microseconds (EncodedVideoChunk.timestamp)
//   bytes 9..   : payload (EncodedVideoChunk data; H.264 in Annex-B so SPS/PPS ride in key frames)
// The sharer sends a config packet before the first key frame and whenever it changes.
// The core re-sends the latest config to each new watcher, then waits for the next key frame.
// The sharer UI must produce a key frame at least every 2 s, and on demand: the core emits the
// `stream_keyframe` event when a new watcher arrives.
export interface StreamConfig {
  codec: string; // e.g. "avc1.64002A", "vp09.00.10.08"
  width: number;
  height: number;
}
export const STREAM_KIND_CONFIG = 0;
export const STREAM_KIND_KEY = 1;
export const STREAM_KIND_DELTA = 2;
export const STREAM_MAX_PACKET = 4 * 1024 * 1024;

export interface ExtraEvents {
  /** Sharer side: please emit a key frame now. */
  stream_keyframe: {};
  /** Sharer side: a watcher's link is saturated; lower the bitrate. */
  stream_congestion: {};
}
