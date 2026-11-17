// User-level actions shared by buttons, shortcuts and the command palette.
import { call, errText, type Id } from "@/ipc";
import { useApp } from "@/state/store";
import { isSharing, stopShare } from "@/media/share";

const fail = (e: unknown) => useApp.getState().toast("error", errText(e));

export function toggleMute() {
  const v = useApp.getState().snap?.voice;
  if (!v) return;
  void call("set_muted", { muted: !v.muted }).catch(fail);
}

export function toggleDeafen() {
  const v = useApp.getState().snap?.voice;
  if (!v) return;
  void call("set_deafened", { deafened: !v.deafened }).catch(fail);
}

export async function joinVoice(space: Id, channel: Id) {
  const s = useApp.getState();
  s.select(space, channel);
  if (s.snap?.voice?.channel === channel) return;
  stopShare();
  try {
    await call("voice_join", { space, channel });
  } catch (e) {
    fail(e);
  }
}

export function leaveVoice() {
  stopShare();
  void call("voice_leave").catch(fail);
}

export function shareScreen() {
  if (!useApp.getState().snap?.voice) {
    useApp.getState().toast("info", "Ekran paylaşmak için önce bir ses odasına katıl");
    return;
  }
  if (isSharing()) stopShare();
  else useApp.getState().openDialog("share");
}

export async function copy(text: string, what = "Kopyalandı") {
  try {
    await navigator.clipboard.writeText(text);
    useApp.getState().toast("info", what);
  } catch {
    useApp.getState().toast("error", "Panoya kopyalanamadı");
  }
}

export { fail };
