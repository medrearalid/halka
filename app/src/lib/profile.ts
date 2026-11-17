import { useEffect, useState } from "react";
import { call, type Id } from "@/ipc";
import { useApp } from "@/state/store";

export const DEFAULT_ORB = 0x9f76fa;
export const MAX_BIO = 160;
const MAX_PHOTO = 32 * 1024;
const PHOTO_SIZE = 192;

export function profileColor(value: number) {
  return `#${value.toString(16).padStart(6, "0")}`;
}

export async function preparePhoto(file: File): Promise<Blob> {
  if (file.size > 8 * 1024 * 1024) throw new Error("En fazla 8 MB boyutunda bir fotoğraf seç");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("JPEG, PNG veya WebP fotoğrafı seç");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PHOTO_SIZE;
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Fotoğraf işlenemedi");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  } finally {
    bitmap.close();
  }
  for (const quality of [0.88, 0.73, 0.56]) {
    const photo = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (photo?.type === "image/webp" && photo.size <= MAX_PHOTO) return photo;
  }
  throw new Error("Fotoğraf WebP olarak hazırlanamadı");
}

export async function encodePhoto(photo: Blob) {
  const bytes = new Uint8Array(await photo.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type PhotoEntry = { refs: number; url: string | null; ready: Promise<string | null> };
const photos = new Map<Id, PhotoEntry>();

function trimPhotos() {
  for (const [hash, entry] of photos) {
    if (photos.size <= 32) break;
    if (entry.refs) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    photos.delete(hash);
  }
}

function photoEntry(member: Id, hash: Id): PhotoEntry {
  const cached = photos.get(hash);
  if (cached) {
    photos.delete(hash);
    photos.set(hash, cached);
    return cached;
  }
  const entry: PhotoEntry = {
    refs: 0,
    url: null,
    ready: call("profile_photo", { member, hash }).then((base64) => {
      if (photos.get(hash) !== entry) return null;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      entry.url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
      return entry.url;
    }).catch(() => {
      if (photos.get(hash) === entry) photos.delete(hash);
      return null;
    }),
  };
  photos.set(hash, entry);
  return entry;
}

export function useProfilePhoto(member: Id, enabled: boolean) {
  const hash = useApp((s) => enabled ? s.snap?.profiles[member]?.photo : null);
  const [loaded, setLoaded] = useState<{ hash: Id; url: string } | null>(null);
  useEffect(() => {
    if (!hash) return;
    let active = true;
    const entry = photoEntry(member, hash);
    entry.refs++;
    trimPhotos();
    void entry.ready.then((url) => {
      if (active && url) setLoaded({ hash, url });
    });
    return () => {
      active = false;
      entry.refs--;
      trimPhotos();
    };
  }, [member, hash]);
  // A previous render's URL is unusable after its hash has been evicted.
  return hash && loaded?.hash === hash && photos.get(hash)?.url === loaded.url ? loaded.url : null;
}
