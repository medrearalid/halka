import { expect, test } from "bun:test";
import { cueSamples, statusCue } from "../src/lib/statusSounds";

const room = { space: "space", channel: "room", muted: false, deafened: false };
const connected = { online: true, voice: null };
const joined = { ...connected, voice: room };
const muted = { ...connected, voice: { ...room, muted: true } };
const deafened = { ...connected, voice: { ...room, deafened: true } };
const both = { ...connected, voice: { ...room, muted: true, deafened: true } };

test("confirmed status changes produce one cue, prioritizing room and combined changes", () => {
  expect(statusCue(null, connected)).toBe("online");
  expect(statusCue(connected, { online: false, voice: null })).toBe("offline");
  expect(statusCue(connected, joined)).toBe("join");
  expect(statusCue(joined, connected)).toBe("leave");
  expect(statusCue(both, { ...joined, voice: { ...room, channel: "other" } })).toBe("switchRoom");
  expect(statusCue(joined, muted)).toBe("mute");
  expect(statusCue(muted, joined)).toBe("unmute");
  expect(statusCue(joined, deafened)).toBe("deafen");
  expect(statusCue(deafened, joined)).toBe("undeafen");
  expect(statusCue(muted, both)).toBe("muteBoth");
  expect(statusCue(joined, both)).toBe("muteBoth");
  expect(statusCue(both, joined)).toBe("unmuteBoth");
  expect(statusCue(both, { ...both, voice: { ...both.voice } })).toBeUndefined();
  expect(statusCue(null, { online: false, voice: null })).toBeUndefined();
});

test("cues are distinct, short, quiet and start and end without clicks", () => {
  const kinds = [
    "online", "offline", "join", "leave", "switchRoom", "mute", "unmute",
    "deafen", "undeafen", "muteBoth", "unmuteBoth", "shareStart", "shareEnd",
  ] as const;
  const rate = 48000;
  const waveforms = kinds.map((kind) => {
    const samples = cueSamples(kind, rate);
    expect(samples.length / rate).toBeGreaterThanOrEqual(0.15);
    expect(samples.length / rate).toBeLessThanOrEqual(0.29);
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(0);
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(peak).toBeCloseTo(0.072, 5);
    return new Bun.CryptoHasher("sha256").update(new Uint8Array(samples.buffer)).digest("hex");
  });
  expect(new Set(waveforms).size).toBe(kinds.length);
  // The paired mute has a deliberate silent beat that the single mute doesn't.
  const at = (ms: number) => Math.round(ms * rate / 1000);
  expect(cueSamples("muteBoth", rate).subarray(at(86), at(97)).every((sample) => sample === 0)).toBe(true);
  expect(cueSamples("mute", rate).subarray(at(86), at(97)).some((sample) => Math.abs(sample) > 0.008)).toBe(true);
});
