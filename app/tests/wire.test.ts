// bun test — wire format + seat geometry (both are contracts with the Rust core)
import { expect, test } from "bun:test";
import { packConfig, packPacket, parseConfig, parsePacket } from "../src/media/packet";
import { seatAngles } from "../src/lib/seats";

test("packet round-trip: kind, u64 LE µs timestamp, payload", () => {
  const buf = packPacket(2, 123_456_789_012, new Uint8Array([9, 8, 7]));
  expect(new Uint8Array(buf, 0, 9)).toEqual(new Uint8Array([2, 0x14, 0x1a, 0x99, 0xbe, 0x1c, 0, 0, 0]));
  const p = parsePacket(buf)!;
  expect(p.kind).toBe(2);
  expect(p.timestamp).toBe(123_456_789_012);
  expect([...p.data]).toEqual([9, 8, 7]);
  const c = parsePacket(packConfig({ codec: "avc1.64002A", width: 1920, height: 1080 }))!;
  expect(c.kind).toBe(0);
  expect(parseConfig(c.data)).toEqual({ codec: "avc1.64002A", width: 1920, height: 1080 });
  expect(parsePacket(new ArrayBuffer(4))).toBeNull();
});

test("seats: self at 6 o'clock, others by id ascending, clockwise", () => {
  const s = seatAngles("m", ["z", "m", "a", "c"]).map((x) => ({ id: x.id, t: x.theta }));
  expect(s.map((x) => x.id)).toEqual(["m", "a", "c", "z"]);
  const pan = s.map((x) => Math.round(-Math.sin(x.t) * 100) / 100);
  expect(pan).toEqual([-0, -1, -0, 1]); // a hard left, c opposite, z hard right
});
