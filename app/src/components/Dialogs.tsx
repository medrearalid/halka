import { useState, type ReactNode } from "react";
import { Hash, Volume2 } from "lucide-react";
import { call, type ChannelKind } from "@/ipc";
import { useApp } from "@/state/store";
import { useSpace } from "@/lib/space";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Segmented } from "./common";
import { InviteCreator } from "./InviteCreator";
import { CreateSpaceForm, JoinForm, useSubmit } from "./forms";
import { SpaceSettings } from "./SpaceSettings";
import { AppSettings } from "./AppSettings";
import { ShareSheet } from "./ShareSheet";
import { ProfilePanel } from "./ProfilePanel";

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const close = useApp((s) => s.closeDialog);
  const kind = dialog?.kind;
  const big = kind === "space-settings" || kind === "app-settings";
  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && close()}>
      {dialog && (
        <DialogContent
          className={cn(
            "gap-0 overflow-hidden border-line-2 bg-paper-1 p-0",
            big
              ? "h-[min(600px,calc(100vh-48px))] w-[min(820px,calc(100vw-32px))] max-w-none sm:max-w-none"
              : kind === "share"
                ? "w-[440px] sm:max-w-[440px]"
                : kind === "profile" ? "w-[min(444px,calc(100dvw-32px))] max-w-none sm:max-w-none" : "w-[380px] sm:max-w-[380px]",
          )}
          aria-describedby={undefined}
          // settings open on their content, not with a focus ring on the first tab
          onOpenAutoFocus={big ? (e) => (e.preventDefault(), (e.currentTarget as HTMLElement).focus()) : undefined}
          onCloseAutoFocus={dialog.kind === "profile" ? (event) => {
            if (dialog.trigger?.isConnected) {
              event.preventDefault();
              dialog.trigger.focus();
            }
          } : undefined}
        >
          {dialog.kind === "profile" ? (
            <ProfilePanel key={dialog.member} member={dialog.member} space={dialog.space} />
          ) : dialog.kind === "space-settings" ? (
            <SpaceSettings initialTab={dialog.tab} />
          ) : kind === "app-settings" ? (
            <AppSettings />
          ) : kind === "create-space" ? (
            <Small title="Yeni halka" desc="Bir isim ver; kanalları ve rolleri sonra ayarlarsın.">
              <CreateSpaceForm autoFocus onDone={close} />
            </Small>
          ) : kind === "join-space" ? (
            <Small title="Davetle katıl" desc="Katıldığında halkadakilerle doğrudan bağlanırsın.">
              <JoinForm autoFocus onDone={close} />
            </Small>
          ) : kind === "invite" ? (
            <Small title="Davet et" desc="Kodu arkadaşına gönder. Kod tek başına yeterli; sunucu yok.">
              <InviteCreator />
            </Small>
          ) : kind === "share" ? (
            <ShareSheet onDone={close} />
          ) : kind === "create-channel" ? (
            <Small title="Kanal oluştur">
              <CreateChannelForm onDone={close} />
            </Small>
          ) : null}
        </DialogContent>
      )}
    </Dialog>
  );
}

function Small({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="pr-6">
        <DialogTitle className="text-[14px] font-semibold tracking-tight">{title}</DialogTitle>
        {desc && <DialogDescription className="mt-1 text-xs text-ink-3">{desc}</DialogDescription>}
      </div>
      {children}
    </div>
  );
}

function CreateChannelForm({ onDone }: { onDone: () => void }) {
  const space = useSpace();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("text");
  const clean = kind === "text" ? name.trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, "-") : name.trim();
  const { busy, error, run } = useSubmit(
    () => call("create_channel", { space: space!.id, name: clean, kind, privateRoles: null }),
    (id) => {
      useApp.getState().select(space!.id, id);
      onDone();
    },
  );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean) void run();
      }}
    >
      <Segmented
        value={kind}
        onChange={setKind}
        className="w-full"
        options={[
          { value: "text", label: <span className="flex items-center justify-center gap-1"><Hash className="size-3" /> Metin kanalı</span> },
          { value: "voice", label: <span className="flex items-center justify-center gap-1"><Volume2 className="size-3" /> Ses odası</span> },
        ]}
      />
      <input className="field" autoFocus placeholder={kind === "text" ? "kanal-adı" : "Oda adı"} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Kanal adı" />
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button type="submit" disabled={!clean} aria-busy={busy}>
        Oluştur
      </Button>
    </form>
  );
}
