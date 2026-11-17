// Sharer side: capture screen, encode off the main thread, push packets to the core.
import { call, errText, on } from "@/ipc";
import { useApp } from "@/state/store";
import { runEncoder } from "./encoder";

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };

const FPS = 30;
const MAX_IN_FLIGHT = 8;

let active: { stop: () => void } | null = null;

export function isSharing() {
  return active !== null;
}

export async function startShare(): Promise<void> {
  if (active) return;
  const app = useApp.getState();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: FPS, max: 60 } }, audio: false });
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
  let stopEncoder = () => {
    worker.postMessage({ type: "stop" });
    setTimeout(() => worker.terminate(), 500);
  };
  const MSTP = (globalThis as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
  try {
    // 1) transfer a clone of the track (keeps the original for the local preview)
    const clone = track.clone();
    try {
      worker.postMessage({ type: "start", track: clone, framerate: FPS }, [clone as unknown as Transferable]);
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
      worker.postMessage({ type: "start", readable, framerate: FPS }, [readable as unknown as Transferable]);
    } catch {
      // 3) encode on the main thread
      worker.terminate();
      const loop = runEncoder(readable, send, onErr, FPS);
      requestKey = loop.requestKeyFrame;
      stopEncoder = loop.stop;
    }
  }
  const offKey = on("stream_keyframe", () => requestKey());

  const stop = () => {
    if (active !== handle) return;
    active = null;
    offKey();
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
