// Sharer side: capture screen, encode off the main thread, push packets to the core.
import { call, isTauri, makeChannel, on } from "@/ipc";
import { useApp } from "@/state/store";
import { runEncoder } from "./encoder";

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

const MAX_IN_FLIGHT = 8;
export const usesNativeCapture = isTauri && navigator.userAgent.includes("Windows");

export type ShareSurface = "monitor" | "window";
export type SharePreset = "smooth" | "balanced" | "sharp" | "maximum";
export const PRESETS: Record<SharePreset, { label: string; detail: string; height: number; fps: number; bitrate: number }> = {
  smooth: { label: "Akıcı", detail: "720p · 60 fps", height: 720, fps: 60, bitrate: 3_500_000 },
  balanced: { label: "Dengeli", detail: "1080p · 30 fps", height: 1080, fps: 30, bitrate: 4_500_000 },
  sharp: { label: "Net", detail: "1080p · 60 fps", height: 1080, fps: 60, bitrate: 8_000_000 },
  maximum: { label: "En yüksek", detail: "Kaynağa göre", height: 0, fps: 0, bitrate: 0 },
};
export interface ShareOptions {
  surface: ShareSurface;
  preset: SharePreset;
  source?: string;
}

let active: { stop: () => void; preview?: (receiver: (packet: ArrayBuffer) => void) => () => void } | null = null;
let starting: AbortController | null = null;

export function isSharing() {
  return active !== null || starting !== null;
}

export function previewShare(receiver: (packet: ArrayBuffer) => void) {
  return active?.preview?.(receiver);
}

async function startNative(opts: ShareOptions, signal: AbortSignal): Promise<boolean> {
  if (!opts.source) return false;
  const id = crypto.randomUUID();
  let receiver: ((packet: ArrayBuffer) => void) | undefined;
  const channel = await makeChannel((packet) => receiver?.(packet));
  if (signal.aborted) return false;
  const stop = () => {
    receiver = undefined;
    offEnded();
    if (active === handle) {
      active = null;
      useApp.setState({ nativeShare: false });
    }
    void call("capture_stop", { id }).catch(() => {});
  };
  const handle = {
    stop,
    preview(next: (packet: ArrayBuffer) => void) {
      receiver = next;
      void call("capture_preview", { id, enabled: true }).catch(() => {});
      return () => {
        if (receiver !== next) return;
        receiver = undefined;
        void call("capture_preview", { id, enabled: false }).catch(() => {});
      };
    },
  };
  let ended = false;
  let endError: string | null = null;
  const offEnded = on("capture_ended", (event) => {
    if (event.id !== id) return;
    ended = true;
    endError = event.error;
    if (active === handle && endError) useApp.getState().toast("error", endError);
    stop();
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    await call("capture_start", { id, source: opts.source, preset: opts.preset, preview: channel });
    if (signal.aborted || ended) {
      stop();
      if (!signal.aborted && endError) throw new Error(endError);
      return false;
    }
    active = handle;
    useApp.setState({ nativeShare: true });
    return true;
  } catch (error) {
    stop();
    if (!signal.aborted) throw error;
    return false;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function startShare(opts: ShareOptions): Promise<boolean> {
  if (isSharing()) return false;
  const controller = new AbortController();
  starting = controller;
  try {
    return await (usesNativeCapture ? startNative(opts, controller.signal) : startBrowser(opts, controller.signal));
  } finally {
    if (starting === controller) starting = null;
  }
}

async function startBrowser(opts: ShareOptions, signal: AbortSignal): Promise<boolean> {
  const p = PRESETS[opts.preset];
  let stream: MediaStream;
  try {
    // Hints make the system picker open on the right tab with only the relevant sources.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: p.height
        ? { displaySurface: opts.surface, frameRate: { ideal: p.fps, max: p.fps }, height: { max: p.height }, width: { max: Math.round((p.height * 16) / 9) } }
        : { displaySurface: opts.surface, frameRate: { ideal: 120 } },
      audio: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: opts.surface === "monitor" ? "include" : "exclude",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    if ((e as DOMException)?.name !== "NotAllowedError" && !signal.aborted) throw e;
    return false;
  }
  const track = stream.getVideoTracks()[0];
  if (!track || signal.aborted) {
    stream.getTracks().forEach((t) => t.stop());
    return false;
  }
  const FPS = p.fps || track.getSettings().frameRate || 60;
  const bitrate = p.bitrate || undefined;
  try {
    await call("stream_start");
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    if (!signal.aborted) throw e;
    return false;
  }
  if (signal.aborted) {
    stream.getTracks().forEach((t) => t.stop());
    await call("stream_stop").catch(() => {});
    return false;
  }

  // Ordered send queue; under backpressure drop deltas and ask for a fresh key frame.
  let chain = Promise.resolve();
  let inFlight = 0;
  let requestKey = () => {};
  let skipping = false; // once a delta is dropped, later deltas reference a missing frame
  const send = (pkt: ArrayBuffer) => {
    const kind = new Uint8Array(pkt, 0, 1)[0];
    if (kind === 1) skipping = false;
    if (kind === 2 && (skipping || inFlight >= MAX_IN_FLIGHT)) {
      if (!skipping) requestKey();
      skipping = true;
      return;
    }
    inFlight++;
    chain = chain
      .then(() => call("stream_packet", pkt))
      .catch(() => {})
      .finally(() => void inFlight--);
  };
  const onErr = (msg: string) => useApp.getState().toast("error", msg);

  const worker = new Worker(new URL("./share.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ type: string; pkt?: ArrayBuffer; msg?: string }>) => {
    if (e.data.type === "packet" && e.data.pkt) send(e.data.pkt);
    else if (e.data.type === "error") onErr(e.data.msg ?? "Kodlama hatası");
  };
  requestKey = () => worker.postMessage({ type: "key" });
  let congest = () => worker.postMessage({ type: "congestion" });
  let stopEncoder = () => {
    worker.postMessage({ type: "stop" });
    setTimeout(() => worker.terminate(), 500);
  };
  const MSTP = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  try {
    // 1) transfer a clone of the track (keeps the original for the local preview)
    const clone = track.clone();
    try {
      worker.postMessage({ type: "start", track: clone, framerate: FPS, bitrate }, [clone as unknown as Transferable]);
    } catch (e) {
      clone.stop(); // not transferable: do not leave a live capture behind
      throw e;
    }
  } catch {
    if (!MSTP) {
      worker.terminate();
      stream.getTracks().forEach((t) => t.stop());
      void call("stream_stop");
      throw new Error("Ekran paylaşımı bu sistemde desteklenmiyor");
    }
    const readable = new MSTP({ track }).readable;
    try {
      // 2) transfer the frame stream
      worker.postMessage({ type: "start", readable, framerate: FPS, bitrate }, [readable as unknown as Transferable]);
    } catch {
      // 3) encode on the main thread
      worker.terminate();
      const loop = runEncoder(readable, send, onErr, FPS, bitrate);
      requestKey = loop.requestKeyFrame;
      congest = loop.congestion;
      stopEncoder = loop.stop;
    }
  }
  const offKey = on("stream_keyframe", () => requestKey());
  const offCongest = on("stream_congestion", () => congest());

  const stop = () => {
    if (active !== handle) return;
    active = null;
    offKey();
    offCongest();
    stopEncoder();
    stream.getTracks().forEach((t) => t.stop());
    useApp.setState({ localStream: null });
    void chain.then(() => call("stream_stop")).catch(() => {});
  };
  const handle = { stop };
  active = handle;
  track.addEventListener("ended", stop);
  useApp.setState({ localStream: stream });
  return true;
}

export function stopShare() {
  starting?.abort();
  active?.stop();
}

export function cancelShareStart() {
  if (!active) starting?.abort();
}
