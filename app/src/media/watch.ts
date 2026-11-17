// Viewer side: receive packets on a channel, decode with WebCodecs, paint only the latest frame.
import { call, makeChannel, on, STREAM_KIND_CONFIG, STREAM_KIND_KEY } from "@/ipc";
import { parseConfig, parsePacket } from "./packet";
import type { StreamConfig } from "@/ipc/contract";

export interface WatchHandle {
  stop(): void;
}

export interface WatchCallbacks {
  /** first frame painted / resolution known */
  onSize?(w: number, h: number): void;
  onError?(msg: string): void;
  onEnded?(): void;
}

async function decoderConfig(cfg: StreamConfig): Promise<VideoDecoderConfig> {
  const base: VideoDecoderConfig = { codec: cfg.codec, codedWidth: cfg.width, codedHeight: cfg.height, optimizeForLatency: true };
  const hw = { ...base, hardwareAcceleration: "prefer-hardware" as const };
  try {
    if ((await VideoDecoder.isConfigSupported(hw)).supported) return hw;
  } catch {
    /* fall through */
  }
  return base;
}

export function watchStream(member: string, canvas: HTMLCanvasElement, cb: WatchCallbacks = {}): WatchHandle {
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let decoder: VideoDecoder | null = null;
  let config: StreamConfig | null = null;
  let waitKey = true;
  let pending: VideoFrame | null = null;
  let raf = 0;
  let stopped = false;
  let configuring: Promise<void> = Promise.resolve();

  const paint = () => {
    raf = 0;
    const f = pending;
    pending = null;
    if (!f || !ctx) return f?.close();
    if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
      canvas.width = f.displayWidth;
      canvas.height = f.displayHeight;
      cb.onSize?.(f.displayWidth, f.displayHeight);
    }
    ctx.drawImage(f, 0, 0);
    f.close();
  };

  const reset = () => {
    waitKey = true;
    try {
      decoder?.close();
    } catch {
      /* closed */
    }
    decoder = null;
  };

  const setup = (cfg: StreamConfig) => {
    config = cfg;
    reset();
    configuring = decoderConfig(cfg).then((dc) => {
      if (stopped || config !== cfg) return;
      const d = new VideoDecoder({
        output: (frame) => {
          pending?.close(); // drop stale frames: only the newest is painted
          pending = frame;
          if (!raf) raf = requestAnimationFrame(paint);
        },
        error: () => {
          // wait for the next key frame with a fresh decoder
          if (config && !stopped) setup(config);
        },
      });
      d.configure(dc);
      decoder = d;
    });
  };

  const onPacket = (buf: ArrayBuffer) => {
    if (stopped) return;
    const p = parsePacket(buf);
    if (!p) return;
    if (p.kind === STREAM_KIND_CONFIG) {
      const cfg = parseConfig(p.data);
      if (cfg && (!config || cfg.codec !== config.codec || cfg.width !== config.width || cfg.height !== config.height)) setup(cfg);
      return;
    }
    const key = p.kind === STREAM_KIND_KEY;
    void configuring.then(() => {
      if (!decoder || decoder.state !== "configured") return;
      if (waitKey && !key) return;
      if (decoder.decodeQueueSize > 3 && !key) {
        waitKey = true; // falling behind: skip to the next key frame (deltas need every predecessor)
        return;
      }
      waitKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: p.timestamp, data: p.data }));
      } catch {
        if (config) setup(config);
      }
    });
  };

  const offEnded = on("stream_ended", (e) => e.member === member && cb.onEnded?.());
  let watching = false;
  void makeChannel(onPacket).then((channel) => {
    if (stopped) return;
    watching = true;
    call("watch", { member, channel }).catch((e) => cb.onError?.(String(e)));
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      offEnded();
      if (raf) cancelAnimationFrame(raf);
      pending?.close();
      reset();
      if (watching) void call("unwatch", { member }).catch(() => {});
    },
  };
}
