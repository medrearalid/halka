/** Encoder candidates, best first. H.264 in Annex-B so SPS/PPS ride inside key frames. */
const CANDIDATES: { codec: string; extra: Partial<VideoEncoderConfig> }[] = [
  { codec: "avc1.64002A", extra: { avc: { format: "annexb" }, hardwareAcceleration: "prefer-hardware" } },
  { codec: "avc1.42E01F", extra: { avc: { format: "annexb" } } },
  { codec: "vp09.00.10.08", extra: {} },
  { codec: "vp8", extra: {} },
];

/** ~5 Mbps at 1080p, scaled by pixel count. */
export function bitrateFor(w: number, h: number): number {
  return Math.round(Math.min(8e6, Math.max(1e6, (5e6 * w * h) / (1920 * 1080))));
}

export async function pickEncoderConfig(width: number, height: number, framerate: number, bitrate?: number): Promise<VideoEncoderConfig | null> {
  // H.264 needs even dimensions
  const w = width & ~1, h = height & ~1;
  for (const c of CANDIDATES) {
    const cfg: VideoEncoderConfig = {
      codec: c.codec,
      width: w,
      height: h,
      bitrate: bitrate ?? bitrateFor(w, h),
      bitrateMode: "variable",
      framerate,
      latencyMode: "realtime",
      ...c.extra,
    };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config ?? cfg;
      if (cfg.hardwareAcceleration) {
        const soft = { ...cfg, hardwareAcceleration: "no-preference" as const };
        const r2 = await VideoEncoder.isConfigSupported(soft);
        if (r2.supported) return r2.config ?? soft;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
