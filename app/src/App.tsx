import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useApp } from "@/state/store";
import { call, on } from "@/ipc";
import { usesNativeCapture } from "@/media/share";
import { toggleDeafen, toggleMute } from "@/lib/actions";
import { RingMark } from "@/components/common";
import { Onboarding } from "@/components/Onboarding";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { Dialogs } from "@/components/Dialogs";
import { CommandPalette } from "@/components/CommandPalette";
import { TitleBar } from "@/components/TitleBar";

function useGlobalKeys() {
  useEffect(() => {
    let pttHeld = false;
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    const capturing = () => document.querySelector("[data-key-capture]") !== null;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useApp.getState().watchFullscreen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        useApp.setState({ watchFullscreen: null });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useApp.getState();
        s.setPalette(!s.palette);
        return;
      }
      if (mod && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        return toggleMute();
      }
      if (mod && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        return toggleDeafen();
      }
      const snap = useApp.getState().snap;
      if (snap?.settings.push_to_talk && snap.voice && e.code === snap.settings.ptt_key && !e.repeat && !typing(e.target) && !capturing()) {
        if (!pttHeld) {
          pttHeld = true;
          void call("set_ptt", { down: true });
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      const snap = useApp.getState().snap;
      if (pttHeld && e.code === snap?.settings.ptt_key) {
        pttHeld = false;
        void call("set_ptt", { down: false });
      }
    };
    // never leave the mic open when focus leaves the window
    const blur = () => {
      if (pttHeld) {
        pttHeld = false;
        void call("set_ptt", { down: false });
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

export function App() {
  useGlobalKeys();
  const fullscreen = useApp((s) => s.watchFullscreen !== null);
  useEffect(() => {
    if (!usesNativeCapture) return;
    return on("watch_fullscreen", (target) => {
      if (!target) {
        useApp.setState({ watchFullscreen: null });
        // Back-to-back shortcuts can enter and exit before React has rendered the fullscreen view.
        void call("return_watch_focus", { userInitiated: true }).catch(() => {});
        return;
      }
      useApp.getState().select(target.space, target.channel);
      useApp.setState({ watchFullscreen: target.member, dialog: null, palette: false });
    });
  }, []);
  useEffect(() => {
    if (!usesNativeCapture) return;
    const applyFullscreen = async () => {
      if (!fullscreen) {
        await call("return_watch_focus", { userInitiated: false });
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      if (useApp.getState().watchFullscreen) await getCurrentWindow().setFullscreen(true);
    };
    void applyFullscreen().catch(() => {
      if (fullscreen && useApp.getState().watchFullscreen) {
        useApp.setState({ watchFullscreen: null });
        useApp.getState().toast("error", "Yayın tam ekran açılamadı.");
      }
    });
  }, [fullscreen]);
  const ready = useApp((s) => s.snap !== null);
  const bootError = useApp((s) => s.bootError);
  const needsOnboarding = useApp((s) => !!s.snap && (!s.snap.me.name.trim() || s.snap.me.name === "Anonim" || s.snap.spaces.length === 0));

  return (
    <TooltipProvider delayDuration={600} skipDelayDuration={200}>
      <div className="flex h-full flex-col">
      {!fullscreen && <TitleBar />}
      <div className="min-h-0 flex-1">
      {bootError ? (
        <div className="grid h-full place-items-center">
          <div className="enter flex max-w-sm flex-col items-center gap-2 text-center">
            <RingMark size={28} className="text-danger" />
            <div className="font-medium">Çekirdek başlatılamadı</div>
            <p className="text-xs text-ink-3" data-selectable>
              {bootError}
            </p>
          </div>
        </div>
      ) : !ready ? (
        <div className="grid h-full place-items-center">
          <RingMark size={28} className="animate-[pulse-live_1.6s_ease-in-out_infinite] text-ink-3" />
        </div>
      ) : needsOnboarding ? (
        <Onboarding />
      ) : (
        <>
          <Shell />
          <CommandPalette />
        </>
      )}
      </div>
      </div>
      <Dialogs />
      <Toasts />
    </TooltipProvider>
  );
}
