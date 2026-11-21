import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useLocaleTag, useT } from "@/lib/i18n";

/**
 * The shared clock-in's idle slideshow. Used by the device itself
 * (src/routes/clock.$token.tsx) and by the admin preview on the set-up page,
 * so both show exactly the same thing.
 *
 * It covers the whole screen and has one job besides showing slides: any
 * touch, click, key or mouse movement calls `onWake`, and the keypad is back.
 */

export const KIOSK_SLIDES_BUCKET = "kiosk-slides";

export type KioskSlide = {
  id: string;
  kind: "image" | "message";
  title: string | null;
  body: string | null;
  image_path: string | null;
  duration_seconds: number;
};

export function kioskSlideImageUrl(path: string): string {
  return supabase.storage.from(KIOSK_SLIDES_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Starts loading every picture at once and reports which have arrived. A slide
 * is only shown once its picture is in, so the screen never flashes an empty
 * frame; one that fails to load is simply skipped.
 */
export function usePreloadedSlideImages(slides: KioskSlide[]): Set<string> {
  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const paths = useMemo(
    () => slides.filter((s) => s.kind === "image" && s.image_path).map((s) => s.image_path!),
    [slides],
  );
  const key = paths.join("|");

  useEffect(() => {
    let cancelled = false;
    const imgs = paths.map((path) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        setReady((prev) => {
          if (prev.has(path)) return prev;
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      };
      img.src = kioskSlideImageUrl(path);
      return img;
    });
    return () => {
      cancelled = true;
      for (const img of imgs) img.onload = null;
    };
    // `key` stands for `paths`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ready;
}

/** Slides that can be shown right now: messages, and pictures that have loaded. */
export function playableSlides(slides: KioskSlide[], ready: Set<string>): KioskSlide[] {
  return slides.filter((s) =>
    s.kind === "message"
      ? !!(s.title?.trim() || s.body?.trim())
      : !!s.image_path && ready.has(s.image_path),
  );
}

export function KioskSlideshow({
  slides,
  onWake,
  fading = false,
  wakeOnMove = true,
}: {
  /** Only playable slides (see playableSlides). */
  slides: KioskSlide[];
  onWake: () => void;
  /** True while the overlay is going away: it fades but still swallows the waking tap. */
  fading?: boolean;
  /**
   * The device wakes on any movement or press. The admin preview closes on a
   * click (so the tap can't land on whatever is under it) or a key.
   */
  wakeOnMove?: boolean;
}) {
  const t = useT("time");
  const tag = useLocaleTag();
  const [index, setIndex] = useState(0);
  const [clock, setClock] = useState(() => new Date());

  const count = slides.length;
  const current = count > 0 ? slides[index % count] : null;

  useEffect(() => {
    if (count <= 1 || !current) return;
    const ms = Math.max(2, current.duration_seconds) * 1000;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % count), ms);
    return () => clearTimeout(timer);
  }, [index, count, current]);

  // The list can shrink (a slide switched off, a picture failing) mid-show.
  useEffect(() => {
    if (count > 0 && index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (fading) return;
    const wake = () => onWake();
    window.addEventListener("keydown", wake);
    return () => window.removeEventListener("keydown", wake);
  }, [onWake, fading]);

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={t("Touch the screen to clock in")}
      onPointerDown={fading || !wakeOnMove ? undefined : onWake}
      onPointerMove={fading || !wakeOnMove ? undefined : onWake}
      onWheel={fading || !wakeOnMove ? undefined : onWake}
      onClick={(e) => {
        e.stopPropagation();
        if (!wakeOnMove && !fading) onWake();
      }}
      className={`fixed inset-0 z-50 cursor-pointer select-none overflow-hidden bg-black transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      {slides.map((s, i) => (
        <div
          key={s.id}
          aria-hidden={i !== index % count}
          className={`absolute inset-0 transition-opacity duration-700 ${
            i === index % count ? "opacity-100" : "opacity-0"
          }`}
        >
          {s.kind === "image" && s.image_path ? (
            <ImageSlide src={kioskSlideImageUrl(s.image_path)} />
          ) : (
            <MessageSlide title={s.title} body={s.body} />
          )}
        </div>
      ))}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 bg-gradient-to-t from-black/70 to-transparent px-6 pb-5 pt-16 text-white sm:px-10 sm:pb-8">
        <p className="text-base font-medium sm:text-xl">{t("Touch the screen to clock in")}</p>
        <p className="text-2xl font-semibold tabular-nums sm:text-4xl">
          {clock.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

function ImageSlide({ src }: { src: string }) {
  return (
    <>
      {/* The same picture, blurred, fills the bars a mismatched aspect ratio leaves. */}
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
      />
      <img src={src} alt="" draggable={false} className="relative h-full w-full object-contain" />
    </>
  );
}

function MessageSlide({ title, body }: { title: string | null; body: string | null }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-primary to-primary/70 px-8 py-24 text-center text-primary-foreground sm:px-16">
      {title?.trim() && (
        <h2 className="max-w-5xl text-4xl font-bold leading-tight sm:text-6xl lg:text-7xl">
          {title}
        </h2>
      )}
      {body?.trim() && (
        <p className="mt-6 max-w-4xl whitespace-pre-line text-xl leading-relaxed opacity-90 sm:text-3xl lg:text-4xl">
          {body}
        </p>
      )}
    </div>
  );
}
