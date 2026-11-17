// Realtime encode loop: VideoFrame stream -> wire packets. Runs in a Worker (share.worker.ts)
// or on the main thread as a fallback; also drives the mock's fake stream.
import { STREAM_KIND_DELTA, STREAM_KIND_KEY, STREAM_MAX_PACKET } from "@/ipc/contract";
import { pickEncoderConfig } from "./codec";
import { packConfig, packPacket } from "./packet";

const KEY_INTERVAL_US = 2_000_000;

export interface EncodeLoop {
  requestKeyFrame(): void;
  stop(): void;
  done: Promise<void>;
}

export function runEncoder(
  frames: ReadableStream<VideoFrame>,
  emit: (packet: ArrayBuffer) => void,
  onError: (msg: string) => void,
  framerate = 30,
): EncodeLoop {
  let encoder = null as VideoEncoder | null;
  let curW = 0, curH = 0;
  let forceKey = true;
  let lastKeyTs = -Infinity;
  let stopped = false;
  const reader = frames.getReader();

  const makeEncoder = () =>
    new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const key = chunk.type === "key";
        const pkt = packPacket(key ? STREAM_KIND_KEY : STREAM_KIND_DELTA, chunk.timestamp, data);
        if (pkt.byteLength > STREAM_MAX_PACKET) {
          forceKey = true; // oversize: drop and recover on the next key frame
          return;
        }
        emit(pkt);
      },
      error: (e) => {
        onError(`Kodlayıcı hatası: ${e.message}`);
        encoder = null; // rebuilt on the next frame
        curW = curH = 0;
      },
    });

  const configure = async (w: number, h: number) => {
    const cfg = await pickEncoderConfig(w, h, framerate);
    if (!cfg) throw new Error("Bu cihazda video kodlayıcı bulunamadı");
    if (!encoder || encoder.state === "closed") encoder = makeEncoder();
    encoder.configure(cfg);
    curW = w;
    curH = h;
    emit(packConfig({ codec: cfg.codec, width: cfg.width, height: cfg.height }));
    forceKey = true;
  };

  const done = (async () => {
    try {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          const w = frame.displayWidth, h = frame.displayHeight;
          if (!encoder || w !== curW || h !== curH) await configure(w, h);
          // Stay realtime: drop frames rather than queue
          if (!encoder || encoder.encodeQueueSize > 2) continue;
          const key = forceKey || frame.timestamp - lastKeyTs >= KEY_INTERVAL_US;
          if (key) {
            forceKey = false;
            lastKeyTs = frame.timestamp;
          }
          encoder.encode(frame, { keyFrame: key });
        } finally {
          frame.close();
        }
      }
    } catch (e) {
      if (!stopped) onError(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        if (encoder && encoder.state !== "closed") encoder.close();
      } catch {
        /* already closed */
      }
      reader.releaseLock();
    }
  })();

  return {
    requestKeyFrame: () => (forceKey = true),
    stop: () => {
      stopped = true;
      reader.cancel().catch(() => {});
    },
    done,
  };
}
