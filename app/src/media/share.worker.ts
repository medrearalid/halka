/// <reference lib="webworker" />
import { runEncoder, type EncodeLoop } from "./encoder";

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
};

type In =
  | { type: "start"; track?: MediaStreamTrack; readable?: ReadableStream<VideoFrame>; framerate: number; bitrate?: number }
  | { type: "key" }
  | { type: "congestion" }
  | { type: "stop" };

const self_ = self as unknown as DedicatedWorkerGlobalScope;
let loop: EncodeLoop | null = null;
let track: MediaStreamTrack | undefined;

self_.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "start") {
    track = m.track;
    const readable = m.readable ?? new MediaStreamTrackProcessor({ track: m.track! }).readable;
    loop = runEncoder(
      readable,
      (pkt) => self_.postMessage({ type: "packet", pkt }, [pkt]),
      (msg) => self_.postMessage({ type: "error", msg }),
      m.framerate,
      m.bitrate,
    );
    loop.done.then(() => self_.postMessage({ type: "ended" }));
  } else if (m.type === "key") loop?.requestKeyFrame();
  else if (m.type === "congestion") loop?.congestion();
  else if (m.type === "stop") {
    loop?.stop();
    track?.stop(); // the transferred clone is a live capture of its own
  }
};
