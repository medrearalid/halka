import { STREAM_KIND_CONFIG, STREAM_MAX_PACKET, type StreamConfig } from "@/ipc/contract";

export const HEADER = 9;

/** [kind u8][timestamp u64 LE µs][payload] */
export function packPacket(kind: number, timestampUs: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, kind);
  dv.setBigUint64(1, BigInt(Math.max(0, Math.round(timestampUs))), true);
  new Uint8Array(buf, HEADER).set(payload);
  return buf;
}

export function packConfig(cfg: StreamConfig, timestampUs = 0): ArrayBuffer {
  return packPacket(STREAM_KIND_CONFIG, timestampUs, new TextEncoder().encode(JSON.stringify(cfg)));
}

export interface Packet {
  kind: number;
  timestamp: number;
  data: Uint8Array;
}

export function parsePacket(buf: ArrayBuffer): Packet | null {
  if (buf.byteLength < HEADER || buf.byteLength > STREAM_MAX_PACKET) return null;
  const dv = new DataView(buf);
  return { kind: dv.getUint8(0), timestamp: Number(dv.getBigUint64(1, true)), data: new Uint8Array(buf, HEADER) };
}

export function parseConfig(data: Uint8Array): StreamConfig | null {
  try {
    const c = JSON.parse(new TextDecoder().decode(data)) as StreamConfig;
    return typeof c.codec === "string" && c.width > 0 && c.height > 0 ? c : null;
  } catch {
    return null;
  }
}
