import { Hash, Lock, MessageSquare, UserPlus, Users, Volume2, Settings2 } from "lucide-react";
import { useApp } from "@/state/store";
import { has, useSpace } from "@/lib/space";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { ChatView } from "./ChatView";
import { VoiceRoom } from "./VoiceRoom";
import { MembersPanel } from "./MembersPanel";
import { Empty, IconBtn, RingMark } from "./common";

export function Shell() {
  const space = useSpace();
  const channelId = useApp((s) => s.channel);
  const membersOpen = useApp((s) => s.membersOpen);
  const voiceChatOpen = useApp((s) => s.voiceChatOpen);
  const channel = space?.channels.find((c) => c.id === channelId) ?? null;
  const { setMembersOpen, setVoiceChatOpen, openDialog } = useApp.getState();
  const canSettings =
    !!space && (has(space, "manage_space") || has(space, "manage_channels") || has(space, "manage_roles") || has(space, "ban"));

  return (
    <div className="flex h-full min-w-0">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
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
            {canSettings && (
              <IconBtn label="Halka ayarları" side="bottom" onClick={() => openDialog("space-settings")}>
                <Settings2 />
              </IconBtn>
            )}
            <IconBtn
              label={membersOpen ? "Üyeleri gizle" : "Üyeleri göster"}
              side="bottom"
              aria-pressed={membersOpen}
              onClick={() => setMembersOpen(!membersOpen)}
              className={cn(membersOpen && "bg-paper-3 text-ink-1")}
            >
              <Users />
            </IconBtn>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="@container flex min-w-0 flex-1 flex-col">
            {!space || !channel ? (
              <div className="grid flex-1 place-items-center">
                <Empty icon={<RingMark size={26} />} title="Burada henüz kanal yok" body="Halka ayarlarından bir metin kanalı ya da ses odası oluştur." />
              </div>
            ) : channel.kind === "text" ? (
              <ChatView key={channel.id} space={space} channel={channel} />
            ) : (
              <div key={channel.id} className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
                <VoiceRoom space={space} channel={channel} />
                <aside
                  id="voice-chat"
                  aria-label={`${channel.name} yazışması`}
                  className={cn(
                    "min-h-0 min-w-0 shrink-0 basis-[42%] flex-col border-t border-line bg-paper-1 @2xl:w-[min(42%,340px)] @2xl:basis-auto @2xl:border-t-0 @2xl:border-l",
                    voiceChatOpen ? "flex" : "hidden",
                  )}
                >
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-xs font-medium text-ink-2">
                    <MessageSquare className="size-3.5 text-ink-3" /> Oda yazışması
                  </div>
                  <ChatView space={space} channel={channel} open={voiceChatOpen} />
                </aside>
              </div>
            )}
          </main>
          {membersOpen && space && <MembersPanel space={space} />}
        </div>
      </div>
    </div>
  );
}
