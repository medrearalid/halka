import { call, errText, type Id } from "@/ipc";
import { useApp } from "@/state/store";

type Resume = {
  space: Id | null;
  channel: Id | null;
  welcome: boolean;
  voice: { space: Id; channel: Id; muted: boolean; deafened: boolean } | null;
  join?: string;
};

/** Relay-only binds at startup: save it, remember where we are, relaunch.
 *  `auto`: a relay-required space asked for it, so it ends once no such space is left. */
export async function enableRelay(join?: string, auto = true) {
  const s = useApp.getState();
  const snap = s.snap!;
  await call("set_settings", { settings: { ...snap.settings, relay_only: true, relay_auto: auto } });
  const r: Resume = { space: s.space, channel: s.channel, welcome: s.welcome, voice: snap.voice, join };
  await call("restart_app", { resume: JSON.stringify(r) });
}

/** Put the user back where enableRelay found them. */
export async function resumeAfterRestart() {
  const app = useApp.getState();
  try {
    const raw = await call("take_resume");
    if (!raw) return;
    const r = JSON.parse(raw) as Resume;
    if (r.join) return app.select(await call("join_space", { code: r.join }));
    if (!r.welcome && r.space) app.select(r.space, r.channel);
    if (r.voice) {
      await call("voice_join", { space: r.voice.space, channel: r.voice.channel });
      if (r.voice.muted) await call("set_muted", { muted: true });
      if (r.voice.deafened) await call("set_deafened", { deafened: true });
    }
  } catch (e) {
    app.toast("error", errText(e));
  }
}
