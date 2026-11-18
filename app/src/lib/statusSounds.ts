import type { Snapshot } from "@/ipc/contract";

type Status = Pick<Snapshot, "online" | "voice">;
type Partial = readonly [ratio: number, strength: number, damping: number];

const timbres = {
  felt: { attack: 9, decay: 1.15, partials: [[1, 0.82, 0], [2, 0.14, 1.2], [3, 0.04, 4]] },
  wood: { attack: 5, decay: 1.5, partials: [[1, 0.71, 0], [1.63, 0.21, 2.4], [2.76, 0.08, 7]] },
  glass: { attack: 8, decay: 1.05, partials: [[1, 0.69, 0], [2, 0.17, 1.5], [2.78, 0.14, 3.8]] },
  air: { attack: 29, decay: 0.85, partials: [[1, 0.75, 0], [1.47, 0.17, 0.8], [2, 0.08, 2]] },
} satisfies Record<string, { attack: number; decay: number; partials: Partial[] }>;

type Timbre = keyof typeof timbres;
type Note = readonly [delayMs: number, durationMs: number, fromHz: number, toHz: number, strength: number, timbre: Timbre];

// Connection uses pitched phrases, microphone uses tactile sounds, and headphones use a soft sweep.
const cues = {
  online: [[0, 136, 294, 294, 0.85, "felt"], [63, 144, 370, 370, 0.69, "felt"], [126, 157, 554, 554, 0.48, "glass"]],
  offline: [[0, 239, 333, 185, 0.8, "felt"], [24, 176, 249, 139, 0.45, "felt"]],
  join: [[0, 89, 220, 220, 0.71, "felt"], [102, 150, 440, 440, 0.88, "felt"]],
  leave: [[0, 71, 389, 346, 0.48, "felt"], [91, 148, 175, 153, 0.94, "wood"]],
  switchRoom: [[0, 54, 249, 241, 0.46, "wood"], [57, 54, 384, 376, 0.54, "wood"], [122, 111, 315, 302, 0.82, "felt"]],
  mute: [[0, 155, 208, 147, 1, "wood"]],
  unmute: [[0, 172, 365, 515, 0.8, "glass"]],
  deafen: [[0, 222, 319, 146, 1, "air"]],
  undeafen: [[0, 224, 165, 327, 0.96, "air"], [91, 115, 439, 439, 0.31, "felt"]],
  muteBoth: [[0, 82, 257, 225, 0.64, "wood"], [99, 174, 179, 126, 1, "wood"]],
  unmuteBoth: [[0, 83, 348, 348, 0.6, "glass"], [64, 103, 440, 440, 0.59, "glass"], [131, 142, 587, 587, 0.72, "glass"]],
  shareStart: [[0, 106, 440, 440, 0.78, "glass"], [68, 136, 660, 660, 1, "glass"]],
  shareEnd: [[0, 100, 587, 587, 0.82, "felt"], [63, 137, 330, 330, 1, "felt"]],
} satisfies Record<string, readonly Note[]>;

type Cue = keyof typeof cues;

export function statusCue(before: Status | null, after: Status): Cue | undefined {
  const prev = before?.voice;
  const next = after.voice;
  if (prev && !next) return "leave";
  if (before && next) {
    if (!prev) return "join";
    if (prev.space !== next.space || prev.channel !== next.channel) return "switchRoom";
    if (next.muted && next.deafened && !(prev.muted && prev.deafened)) return "muteBoth";
    if (prev.muted && prev.deafened && !(next.muted || next.deafened)) return "unmuteBoth";
    if (prev.deafened !== next.deafened) return next.deafened ? "deafen" : "undeafen";
    if (prev.muted !== next.muted) return next.muted ? "mute" : "unmute";
  }
  if (after.online !== (before?.online ?? false)) return after.online ? "online" : "offline";
}

export function cueSamples(cue: Cue, sampleRate: number) {
  const notes: readonly Note[] = cues[cue];
  const length = Math.max(...notes.map(([delay, duration]) => delay + duration));
  const samples = new Float32Array(Math.ceil(sampleRate * length / 1000));
  for (const [delay, duration, from, to, strength, timbre] of notes) {
    const { attack, decay, partials } = timbres[timbre];
    const offset = Math.round(sampleRate * delay / 1000);
    const frames = Math.min(samples.length - offset, Math.round(sampleRate * duration / 1000));
    let phase = 0, seed = 17, noise = 0;
    const noiseSmoothing = 1 - Math.exp(-2 * Math.PI * 780 / sampleRate);
    for (let frame = 0; frame < frames; frame++) {
      const t = frame / (frames - 1);
      const onset = Math.sin(Math.PI / 2 * Math.min(1, frame * 1000 / (sampleRate * attack))) ** 2;
      let body = 0;
      for (const [ratio, amplitude, damping] of partials)
        body += amplitude * Math.sin(phase * ratio) * Math.exp(-damping * t);
      if (timbre === "air") {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        noise += noiseSmoothing * (seed / 0x80000000 - 1 - noise);
        body = 0.65 * body + 0.6 * noise;
      }
      samples[offset + frame] += strength * onset * (1 - t) ** decay * body;
      phase += 2 * Math.PI * (from * (to / from) ** t) / sampleRate;
    }
  }
  // Match peak levels so changing timbre or adding notes can't make a cue unexpectedly loud.
  const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
  const gain = 0.072 / peak;
  for (let frame = 0; frame < samples.length; frame++) samples[frame] *= gain;
  return samples;
}

let context: AudioContext | undefined;
const buffers = new Map<Cue, AudioBuffer>();
let current: { source: AudioBufferSourceNode; gain: GainNode } | undefined;
let sequence = 0;
let shareCueUntil = 0;

function releaseCue() {
  if (!context || !current) return;
  const now = context.currentTime;
  current.gain.gain.setValueAtTime(1, now);
  current.gain.gain.linearRampToValueAtTime(0, now + 0.012);
  current.source.stop(now + 0.012);
  current = undefined;
}

export function stopStatusSound() {
  sequence++;
  shareCueUntil = 0;
  releaseCue();
}

export async function playStatusSound(cue: Cue) {
  const start = performance.now();
  if (cue === "shareStart" || cue === "shareEnd") {
    shareCueUntil = start + 220;
  } else if (start < shareCueUntil) {
    return;
  }
  const requested = ++sequence;
  try {
    const ctx = context ??= new AudioContext({ latencyHint: "interactive" });
    if (ctx.state !== "running") {
      // A normal browser may defer resume until a user gesture. Drop expired cues.
      await ctx.resume();
    }
    if (requested !== sequence || performance.now() - start > 240) return;
    let buffer = buffers.get(cue);
    if (!buffer) {
      const samples = cueSamples(cue, ctx.sampleRate);
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      buffers.set(cue, buffer);
    }
    releaseCue();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(ctx.destination);
    current = { source, gain };
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (current?.source === source) current = undefined;
    };
    source.start();
  } catch {
    // An unavailable audio output shouldn't interfere with voice controls.
  }
}
