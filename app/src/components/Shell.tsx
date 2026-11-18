import { useEffect } from "react";
import { Hash, Lock, MessageSquare, SlidersHorizontal, UserPlus, Users, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/state/store";
import { has, useSpace } from "@/lib/space";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { ChatView } from "./ChatView";
import { VoiceRoom } from "./VoiceRoom";
import { MembersPanel } from "./MembersPanel";
import { OrbStage } from "./OrbLayer";
import { VoiceDock } from "./VoiceDock";
import { Empty, IconBtn, RingMark } from "./common";
import { RelayGate } from "./forms";

export function Shell() {
  const space = useSpace();
  const channelId = useApp((s) => s.channel);
  const membersOpen = useApp((s) => s.membersOpen);
  const voiceChatOpen = useApp((s) => s.voiceChatOpen);
  const watchFullscreen = useApp((s) => s.watchFullscreen !== null);
  const relayActive = useApp((s) => s.snap?.active_relay_only ?? false);
  const locked = !!space?.relay_required && !relayActive;
  const channel = locked ? null : (space?.channels.find((c) => c.id === channelId) ?? null);
  const { setMembersOpen, setVoiceChatOpen, openDialog } = useApp.getState();
  useEffect(() => {
    if (!membersOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog]") && setMembersOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [membersOpen, setMembersOpen]);

  return (
    <div className="flex h-full min-w-0">
      {!watchFullscreen && <Sidebar />}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className={cn("h-11 shrink-0 items-center gap-2 border-b border-line px-3", watchFullscreen ? "hidden" : "flex")}>
          {channel ? (
            <>
              {channel.kind === "text" ? <Hash className="size-4 text-ink-3" /> : <Volume2 className="size-4 text-ink-3" />}
              <h1 className="truncate text-[13px] font-semibold tracking-tight">{channel.name}</h1>
              {channel.private_roles && <Lock className="size-3 text-ink-3" aria-label="Özel kanal" />}
              {channel.kind === "voice" && (
                <span className="num text-xs text-ink-3">· {channel.voice.length} kişi</span>
              )}
            </>
          ) : (
            <span className="text-[13px] text-ink-3">Kanal seçilmedi</span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {channel?.kind === "voice" && (
              <>
                <IconBtn
                  label={voiceChatOpen ? "Yazışmayı gizle" : "Yazışmayı göster"}
                  side="bottom"
                  aria-expanded={voiceChatOpen}
                  aria-controls="voice-chat"
                  onClick={() => setVoiceChatOpen(!voiceChatOpen)}
                  className={cn("relative", voiceChatOpen && "bg-paper-3 text-ink-1")}
                >
                  <MessageSquare />
                  {!voiceChatOpen && channel.unread > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-copper" />}
                </IconBtn>
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
              </>
            )}
            {has(space, "invite") && (
              <IconBtn label="Davet et" side="bottom" onClick={() => openDialog("invite")}>
                <UserPlus />
              </IconBtn>
            )}
            {space && (
              <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2" onClick={() => openDialog("space-settings")}>
                <SlidersHorizontal /> Halkayı yönet
              </Button>
            )}
            <IconBtn
              label={membersOpen ? "Üyeleri gizle" : "Üyeleri göster"}
              side="bottom"
              aria-expanded={membersOpen}
              aria-controls={space ? "members-panel" : undefined}
              disabled={!space}
              onClick={() => setMembersOpen(!membersOpen)}
              className={cn(membersOpen && "bg-paper-3 text-ink-1")}
            >
              <Users />
            </IconBtn>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1">
          <main className="@container relative flex min-w-0 flex-1 flex-col">
            {locked ? (
              <div className="grid flex-1 place-items-center">
                <Empty icon={<Lock className="size-6" />} title="Bu halka relay ile açılır" body="Bu halkada bağlantılar bir aktarma sunucusundan (relay) geçer, böylece kimse IP adresini görmez. Relay’i açınca uygulama yeniden başlar ve buraya döner.">
                  <div className="mt-2"><RelayGate note={false} /></div>
                </Empty>
              </div>
            ) : !space || !channel ? (
              <div className="grid flex-1 place-items-center">
                <Empty icon={<RingMark size={26} />} title="Burada henüz kanal yok" body="Halka ayarlarından bir metin kanalı ya da ses odası oluştur." />
              </div>
            ) : channel.kind === "text" ? (
              <ChatView key={channel.id} space={space} channel={channel} />
            ) : (
              <div key={channel.id} className="relative flex min-h-0 flex-1">
                <OrbStage className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <VoiceRoom space={space} channel={channel} />
                  <div className={cn("pointer-events-none absolute inset-x-0 bottom-4 z-10 justify-center", watchFullscreen ? "hidden" : "flex")}>
                    <div className="pointer-events-auto">
                      <VoiceDock space={space} channel={channel} />
                    </div>
                  </div>
                </OrbStage>
                {/* A slim column beside the stage; on narrow windows it floats over it instead of splitting it. */}
                <aside
                  id="voice-chat"
                  aria-label={`${channel.name} yazışması`}
                  className={cn(
                    "glass enter absolute top-2 right-2 bottom-2 z-20 min-h-0 w-[min(320px,calc(100%-16px))] flex-col overflow-hidden rounded-lg",
                    "@3xl:static @3xl:z-auto @3xl:w-[300px] @3xl:shrink-0 @3xl:animate-none @3xl:rounded-none @3xl:border-l @3xl:border-line @3xl:bg-paper-1 @3xl:bg-none @3xl:shadow-none @3xl:backdrop-filter-none @3xl:after:hidden",
                    voiceChatOpen && !watchFullscreen ? "flex" : "hidden",
                  )}
                >
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-xs font-medium text-ink-2">
                    <MessageSquare className="size-3.5 text-ink-3" /> Oda yazışması
                  </div>
                  <ChatView space={space} channel={channel} open={voiceChatOpen} dense />
                </aside>
              </div>
            )}
          </main>
          {space && !watchFullscreen && <MembersPanel key={space.id} space={space} open={membersOpen} />}
        </div>
      </div>
    </div>
  );
}
