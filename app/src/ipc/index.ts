// Typed IPC facade. Real Tauri backend when running inside the shell; an in-memory mock otherwise.
import type { Commands, Events, ExtraEvents } from "./contract";

export * from "./contract";

export type AllEvents = Events & ExtraEvents;
type Args<K extends keyof Commands> = Commands[K]["args"];
type Ret<K extends keyof Commands> = Commands[K]["ret"];

/** Minimal backend surface; the mock implements the same thing. */
export interface Backend {
  invoke(name: string, args?: unknown): Promise<unknown>;
  listen(name: string, cb: (payload: unknown) => void): Promise<() => void>;
  /** A stream channel to pass to `watch`. Tauri: `Channel<ArrayBuffer>`; mock: a plain object. */
  channel(onmessage: (packet: ArrayBuffer) => void): unknown;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const [{ invoke, Channel }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  return {
    invoke: (name, args) => invoke(name, args as never),
    listen: (name, cb) => listen(name, (e) => cb(e.payload)),
    channel: (onmessage) => {
      const ch = new Channel<ArrayBuffer>();
      // Raw-body channel messages arrive as ArrayBuffer; tolerate number[] just in case.
      ch.onmessage = (m) => onmessage(m instanceof ArrayBuffer ? m : new Uint8Array(m as unknown as number[]).buffer);
      return ch;
    },
  };
}

// Kept on globalThis so Vite HMR re-evaluating this module can't fork a second backend.
const g = globalThis as { __halkaBackend?: Promise<Backend> };
const backend: Promise<Backend> = (g.__halkaBackend ??= isTauri
  ? tauriBackend()
  : import("./mock").then((m) => m.createMockBackend()));

export function call<K extends keyof Commands>(
  name: K,
  ...args: {} extends Args<K> ? [args?: Args<K>] : [args: Args<K>]
): Promise<Ret<K>> {
  return backend.then((b) => b.invoke(name, args[0] ?? {})) as Promise<Ret<K>>;
}

/** Subscribe to a backend event. Returns a synchronous unsubscribe. */
export function on<K extends keyof AllEvents>(name: K, cb: (payload: AllEvents[K]) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  backend
    .then((b) => b.listen(name, cb as (p: unknown) => void))
    .then((u) => (dead ? u() : (off = u)));
  return () => {
    dead = true;
    off?.();
  };
}

export async function makeChannel(onmessage: (packet: ArrayBuffer) => void): Promise<unknown> {
  return (await backend).channel(onmessage);
}

/** Errors from commands are human-readable strings; normalise anything else. */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Bilinmeyen hata";
}
