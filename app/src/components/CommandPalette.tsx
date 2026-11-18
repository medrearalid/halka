import type { ReactNode } from "react";
import { Hash, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Plus, Settings, Settings2, Ticket, UserPlus, Users, Volume2, Headphones } from "lucide-react";
import { useApp } from "@/state/store";
import { has } from "@/lib/space";
import { DEAFEN_SHORTCUT, MUTE_SHORTCUT } from "@/lib/shortcutLabels";
import { joinVoice, leaveVoice, shareScreen, toggleDeafen, toggleMute } from "@/lib/actions";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { SpaceGlyph } from "./Sidebar";

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const snap = useApp((s) => s.snap!);
  const spaceId = useApp((s) => s.space);
  const sharing = useApp((s) => s.nativeShare || !!s.localStream);
  const { setPalette, select, openDialog, setMembersOpen } = useApp.getState();
  const space = snap.spaces.find((s) => s.id === spaceId) ?? null;
  const v = snap.voice;

  const run = (fn: () => void) => () => {
    setPalette(false);
    fn();
  };

  // current space first, then the rest
  const ordered = space ? [space, ...snap.spaces.filter((s) => s.id !== space.id)] : snap.spaces;

  return (
    <CommandDialog open={open} onOpenChange={setPalette} title="Komut paleti" description="Kanal ara ya da komut çalıştır" showCloseButton={false} className="top-[18%] w-[560px] translate-y-0 border-line-2 bg-paper-2 sm:max-w-[560px]">
      <CommandInput placeholder="Kanala atla, komut çalıştır…" />
      <CommandList className="max-h-[360px]">
        <CommandEmpty>Sonuç yok.</CommandEmpty>
        <CommandGroup heading="Eylemler">
          {v && (
            <>
              <Item icon={v.muted ? <Mic /> : <MicOff />} onSelect={run(toggleMute)} shortcut={MUTE_SHORTCUT} value="mikrofon sessiz mute">
                {v.muted ? "Mikrofonu aç" : "Mikrofonu kapat"}
              </Item>
              <Item icon={v.deafened ? <Headphones /> : <HeadphoneOff />} onSelect={run(toggleDeafen)} shortcut={DEAFEN_SHORTCUT} value="sağırlaştır deafen kulaklık">
                {v.deafened ? "Sesi aç" : "Sağırlaştır"}
              </Item>
              <Item icon={<MonitorUp />} onSelect={run(shareScreen)} value="ekran paylaş yayın screen share">
                {sharing ? "Ekran paylaşımını durdur" : "Ekranı paylaş"}
              </Item>
              <Item icon={<PhoneOff />} onSelect={run(leaveVoice)} value="odadan ayrıl leave">
                Ses odasından ayrıl
              </Item>
            </>
          )}
          {has(space, "invite") && (
            <Item icon={<UserPlus />} onSelect={run(() => openDialog("invite"))} value="davet et invite">
              Davet et
            </Item>
          )}
          {has(space, "manage_channels") && (
            <Item icon={<Plus />} onSelect={run(() => openDialog("create-channel"))} value="kanal oluştur yeni">
              Kanal oluştur
            </Item>
          )}
          {space && (
            <Item icon={<Settings2 />} onSelect={run(() => openDialog("space-settings"))} value="halka ayarları roller davetler">
              Halka ayarları
            </Item>
          )}
          <Item icon={<Users />} onSelect={run(() => setMembersOpen(!useApp.getState().membersOpen))} value="üyeler panel members">
            Üye panelini aç/kapat
          </Item>
          <Item icon={<Settings />} onSelect={run(() => openDialog("app-settings"))} value="ayarlar settings mikrofon">
            Ayarlar
          </Item>
          <Item icon={<Plus />} onSelect={run(() => openDialog("create-space"))} value="yeni halka oluştur">
            Yeni halka
          </Item>
          <Item icon={<Ticket />} onSelect={run(() => openDialog("join-space"))} value="davetle katıl kod">
            Davetle katıl
          </Item>
        </CommandGroup>
        {ordered.map((s) => (
          <CommandGroup key={s.id} heading={s.name}>
            {s.id !== spaceId && (
              <Item icon={<SpaceGlyph space={s} size={14} />} onSelect={run(() => select(s.id))} value={`halka ${s.name}`}>
                {s.name} halkasına geç
              </Item>
            )}
            {s.channels.map((c) => (
              <Item
                key={c.id}
                icon={c.kind === "text" ? <Hash /> : <Volume2 />}
                onSelect={run(() => (c.kind === "voice" ? void joinVoice(s.id, c.id) : select(s.id, c.id)))}
                value={`${s.name} ${c.name} ${c.id}`}
                hint={c.kind === "voice" ? (c.voice.length ? `${c.voice.length} kişi · katıl` : "katıl") : c.unread ? `${c.unread} yeni` : undefined}
              >
                {c.name}
              </Item>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

function Item({ icon, children, onSelect, shortcut, value, hint }: { icon: ReactNode; children: ReactNode; onSelect: () => void; shortcut?: string; value: string; hint?: string }) {
  return (
    <CommandItem onSelect={onSelect} value={value} className="h-8 gap-2 [&_svg]:size-3.5 [&_svg]:text-ink-3">
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="num text-2xs text-ink-3">{hint}</span>}
      {shortcut && <CommandShortcut className="font-mono text-2xs">{shortcut}</CommandShortcut>}
    </CommandItem>
  );
}
