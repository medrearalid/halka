// Sharer side: capture screen, encode off the main thread, push packets to the core.
import { call, errText, on } from "@/ipc";
import { useApp } from "@/state/store";
import { runEncoder } from "./encoder";

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

const MAX_IN_FLIGHT = 8;

export type ShareSurface = "monitor" | "window";
export type SharePreset = "smooth" | "balanced" | "sharp";
export const PRESETS: Record<SharePreset, { label: string; detail: string; height: number; fps: number; bitrate: number }> = {
  smooth: { label: "Akıcı", detail: "720p · 60 fps", height: 720, fps: 60, bitrate: 3_500_000 },
  balanced: { label: "Dengeli", detail: "1080p · 30 fps", height: 1080, fps: 30, bitrate: 4_500_000 },
  sharp: { label: "Net", detail: "1080p · 60 fps", height: 1080, fps: 60, bitrate: 8_000_000 },
};
export interface ShareOptions {
  surface: ShareSurface;
  preset: SharePreset;
}

let active: { stop: () => void } | null = null;

export function isSharing() {
  return active !== null;
}

export async function startShare(opts: ShareOptions = { surface: "monitor", preset: "balanced" }): Promise<void> {
  if (active) return;
  const app = useApp.getState();
  const p = PRESETS[opts.preset];
  const FPS = p.fps;
  let stream: MediaStream;
  try {
    // Hints make the system picker open on the right tab with only the relevant sources.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: opts.surface, frameRate: { ideal: p.fps, max: p.fps }, height: { max: p.height }, width: { max: Math.round((p.height * 16) / 9) } },
      audio: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: opts.surface === "monitor" ? "include" : "exclude",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    if ((e as DOMException)?.name !== "NotAllowedError") app.toast("error", `Ekran paylaşılamadı: ${errText(e)}`);
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  try {
    await call("stream_start");
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    app.toast("error", errText(e));
    return;
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
      worker.postMessage({ type: "start", track: clone, framerate: FPS, bitrate: p.bitrate }, [clone as unknown as Transferable]);
    } catch (e) {
      clone.stop(); // not transferable: do not leave a live capture behind
      throw e;
    }
  } catch {
    if (!MSTP) {
      worker.terminate();
      stream.getTracks().forEach((t) => t.stop());
      void call("stream_stop");
      onErr("Ekran paylaşımı bu sistemde desteklenmiyor");
      return;
    }
    const readable = new MSTP({ track }).readable;
    try {
      // 2) transfer the frame stream
      worker.postMessage({ type: "start", readable, framerate: FPS, bitrate: p.bitrate }, [readable as unknown as Transferable]);
    } catch {
      // 3) encode on the main thread
      worker.terminate();
      const loop = runEncoder(readable, send, onErr, FPS, p.bitrate);
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
}

export function stopShare() {
  active?.stop();
}

export function toggleShare() {
  return active ? stopShare() : startShare();
}
