import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Copy, Pencil, ShieldCheck } from "lucide-react";
import { call, type Id, type Me, type ProfileView } from "@/ipc";
import { copy } from "@/lib/actions";
import { DEFAULT_ORB, encodePhoto, MAX_BIO, preparePhoto, profileColor } from "@/lib/profile";
import { memberOf } from "@/lib/space";
import { useApp } from "@/state/store";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Field } from "./common";
import { useSubmit } from "./forms";
import { OrbAvatar } from "./OrbAvatar";

export function ProfilePanel({ member, space }: { member: Id; space: Id | null }) {
  const me = useApp((s) => s.snap!.me);
  const online = useApp((s) => s.snap!.online);
  const context = useApp((s) => s.snap!.spaces.find((item) => item.id === space));
  const profile = useApp((s) => s.snap!.profiles[member]);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const self = me.id === member;
  const peer = memberOf(context, member);
  const person = self ? me : peer;
  if (!person) return <DialogTitle className="p-6 text-sm">Profil artık görünmüyor</DialogTitle>;

  const roles = context?.roles.filter((role) => peer?.roles.includes(role.id)) ?? [];
  return (
    <div className="max-h-[min(680px,calc(100dvh-48px))] overflow-y-auto overscroll-contain">
      {self && editing ? (
        <ProfileEditor me={me} profile={profile} onDone={() => {
          setEditing(false);
          requestAnimationFrame(() => editButton.current?.focus());
        }} />
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-5 border-b border-line bg-paper-2 px-6 py-6">
            <OrbAvatar id={member} name={person.name} size={54} />
            <div className="min-w-0 flex-1">
              {self && <p className="mb-1 text-xs text-ink-3">Profilim</p>}
              <DialogTitle className="pr-4 text-[20px] leading-tight font-semibold wrap-anywhere">{person.name}</DialogTitle>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-2">
                <span aria-hidden className={`size-1.5 rounded-full ${(self ? online : peer?.online) ? "bg-live" : "bg-ink-3"}`} />
                {(self ? online : peer?.online) ? "Çevrimiçi" : "Çevrimdışı"}
              </p>
            </div>
            {self && (
              <Button ref={editButton} variant="secondary" size="sm" onClick={() => setEditing(true)} className="mt-5">
                <Pencil /> Düzenle
              </Button>
            )}
          </div>
          <div className="space-y-4 px-6 py-4">
            {profile?.bio && (
              <section>
                <h2 className="mb-1 text-xs font-semibold">Hakkında</h2>
                <p data-selectable className="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-ink-2">{profile.bio}</p>
              </section>
            )}
            {(roles.length > 0 || peer?.is_owner) && (
              <section aria-label="Halka rolleri">
                <h2 className="mb-2 text-xs font-semibold">{context?.name} rolleri</h2>
                <ul className="flex flex-wrap gap-1.5">
                  {peer?.is_owner && <li className="rounded-md border px-2 py-0.5 text-xs text-copper">Kurucu</li>}
                  {roles.map((role) => (
                    <li key={role.id} className="flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-ink-2">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: profileColor(role.color) }} />
                      <span className="truncate">{role.name}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <details>
              <summary className="w-fit cursor-pointer rounded text-xs font-medium text-ink-2">Güvenlik kodu</summary>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ShieldCheck aria-hidden className="size-4 text-ink-3" />
                <code data-selectable className="font-mono tracking-wide">{person.code}</code>
                <Button size="sm" variant="ghost" onClick={() => void copy(person.code, "Güvenlik kodu kopyalandı")}>
                  <Copy /> Kopyala
                </Button>
              </div>
              <p className="mt-1 text-xs text-ink-3">Kimliği doğrulamak için kodu karşılaştır.</p>
            </details>
          </div>
        </>
      )}
    </div>
  );
}

function ProfileEditor({ me, profile, onDone }: { me: Me; profile?: ProfileView; onDone: () => void }) {
  const [name, setName] = useState(me.name);
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [color, setColor] = useState(profile?.orb_color ?? DEFAULT_ORB);
  const [photo, setPhoto] = useState<Blob | null>();
  const [photoUrl, setPhotoUrl] = useState<string>();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const save = useSubmit(async () => call("update_profile", {
    name: name.trim(),
    bio: bio.trim(),
    orbColor: color,
    photo: photo === undefined ? { kind: "keep" } : photo === null ? { kind: "remove" } : { kind: "replace", data: await encodePhoto(photo) },
  }), onDone);

  async function loadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError("");
    try {
      setPhoto(await preparePhoto(file));
    } catch (error) {
      setPhotoError(error instanceof Error && error.name === "Error" ? error.message : "Fotoğraf okunamadı");
    } finally {
      setPhotoBusy(false);
    }
  }

  const dirty = name.trim() !== me.name || bio.trim() !== (profile?.bio ?? "") || color !== (profile?.orb_color ?? DEFAULT_ORB) || photo !== undefined;
  const hasPhoto = photo === undefined ? !!profile?.photo : !!photo;
  return (
    <form className="space-y-4 p-6" onSubmit={(event) => {
      event.preventDefault();
      if (dirty && name.trim() && !photoBusy) void save.run();
    }}>
      <DialogTitle className="text-lg font-semibold">Profili düzenle</DialogTitle>
      <fieldset disabled={save.busy} className="space-y-4">
        <div className="flex min-w-0 items-center gap-5 rounded-md border bg-paper-2 p-4">
          <OrbAvatar id={me.id} name={name.trim() || me.name} size={56} color={color} photoSrc={photo ? photoUrl ?? null : photo} />
          <div className="min-w-0 flex-1 space-y-2">
            <label className="flex w-fit items-center gap-2 text-xs font-medium">
              <input className="orb-color" type="color" defaultValue={profileColor(color)} onInput={(e) => setColor(Number.parseInt(e.currentTarget.value.slice(1), 16))} />
              Orb rengi
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="relative inline-flex h-7 items-center rounded-md bg-paper-3 px-2 text-xs font-medium hover:bg-paper-4 focus-within:outline-2 focus-within:outline-copper">
                {photoBusy ? "Fotoğraf işleniyor…" : "Fotoğraf seç"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Profil fotoğrafı seç"
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                  disabled={photoBusy}
                  onChange={(event) => void loadPhoto(event)}
                />
              </label>
              {hasPhoto && (
                <Button type="button" size="sm" variant="ghost" disabled={photoBusy} onClick={() => {
                  setPhoto(profile?.photo ? null : undefined);
                  setPhotoError("");
                }}>
                  Kaldır
                </Button>
              )}
            </div>
          </div>
        </div>
        {photoError && <p role="alert" className="text-xs text-danger">{photoError}</p>}
        <Field label="Görünen ad">
          <input className="field" value={name} autoFocus required onChange={(e) => setName(Array.from(e.target.value).slice(0, 32).join(""))} />
        </Field>
        <Field label="Hakkında">
          <textarea
            className="field h-auto min-h-20 resize-y py-2"
            value={bio}
            onChange={(e) => setBio(Array.from(e.target.value).slice(0, MAX_BIO).join(""))}
            aria-describedby="profile-bio-count"
          />
        </Field>
        <p id="profile-bio-count" className="-mt-3 text-right text-xs text-ink-3">{Array.from(bio).length}/{MAX_BIO}</p>
      </fieldset>
      {save.error && <p role="alert" className="text-xs text-danger">{save.error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={save.busy} onClick={onDone}>Vazgeç</Button>
        <Button type="submit" disabled={!dirty || !name.trim() || photoBusy || save.busy} aria-busy={save.busy}>Kaydet</Button>
      </div>
    </form>
  );
}
