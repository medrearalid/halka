import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { Id } from "@/ipc";
import { levelRef } from "@/lib/levels";
import { DEFAULT_ORB, profileColor } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { Avatar } from "./common";

export function OrbAvatar({ id, name, size, muted, deafened, mini, live, color, photoSrc, children }: {
  id: Id;
  name: string;
  size: number;
  muted?: boolean;
  deafened?: boolean;
  mini?: boolean;
  live?: boolean;
  color?: number;
  photoSrc?: string | null;
  children?: ReactNode;
}) {
  const storedColor = useApp((s) => s.snap?.profiles[id]?.orb_color ?? DEFAULT_ORB);
  const ref = useMemo(() => live ? levelRef(id, "orb") : undefined, [id, live]);
  return (
    <span
      ref={ref}
      className={cn("voice-orb relative isolate inline-block shrink-0 align-middle", mini && "voice-orb-mini")}
      data-silent={!!(muted || deafened)}
      style={{ width: size, height: size, "--orb-color": profileColor(color ?? storedColor) } as CSSProperties}
    >
      <span className="voice-orb-light" aria-hidden />
      <Avatar
        id={id}
        name={name}
        size={size}
        photoSrc={photoSrc}
        className={cn("voice-orb-avatar", deafened && "opacity-60")}
        style={{ fontSize: Math.round(size * 0.32) }}
      />
      {children}
    </span>
  );
}
