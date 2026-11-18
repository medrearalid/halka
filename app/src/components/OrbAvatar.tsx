import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { Id } from "@/ipc";
import { levelRef } from "@/lib/levels";
import { DEFAULT_ORB, profileColor } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { Avatar } from "./common";
import { useOrbLayer } from "./OrbLayer";

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
  const orbColor = color ?? storedColor;
  const silent = !!(muted || deafened);
  const layer = useOrbLayer();
  // Stage seats are drawn on the GPU; mini seats and previews keep the CSS hairline.
  const gpu = !!(live && !mini && layer);
  const el = useRef<HTMLSpanElement | null>(null);
  const level = useMemo(() => (live && !gpu ? levelRef(id) : undefined), [id, live, gpu]);
  const ref = useCallback(
    (node: HTMLSpanElement | null) => {
      el.current = node;
      return level?.(node);
    },
    [level],
  );

  useEffect(() => {
    if (!gpu || !el.current) return;
    return layer!.add(el.current, id, orbColor, silent);
  }, [gpu, layer, id, orbColor, silent]);

  return (
    <span
      ref={ref}
      className={cn("voice-orb relative isolate inline-block shrink-0 align-middle", mini && "voice-orb-mini")}
      data-silent={silent}
      data-gl={gpu}
      style={{ width: size, height: size, "--orb-color": profileColor(orbColor) } as CSSProperties}
    >
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
