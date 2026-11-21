import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  MonitorPlay,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  KIOSK_SLIDES_BUCKET,
  KioskSlideshow,
  kioskSlideImageUrl,
  playableSlides,
  usePreloadedSlideImages,
  type KioskSlide,
} from "@/components/kiosk-slideshow";
import { useT } from "@/lib/i18n";

/**
 * The "Display" section of the shared clock-in set-up page: simple keypad or
 * slideshow, how long the keypad waits before the slideshow comes back, and
 * the slides themselves. The device reads all of it through kiosk_display
 * (20261123120000_kiosk_slideshow.sql).
 */

type Mode = "simple" | "slideshow";
type SlideRow = KioskSlide & { enabled: boolean; position: number };

const DEFAULT_IDLE = 30;
const DEFAULT_DURATION = 8;
const MIN_DURATION = 2;
const MAX_DURATION = 300;
const MIN_IDLE = 5;
const MAX_IDLE = 3600;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function KioskDisplaySettings({ companyId }: { companyId: string }) {
  const t = useT("time");
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("simple");
  const [idle, setIdle] = useState(String(DEFAULT_IDLE));
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<SlideRow | "new" | null>(null);
  const [preview, setPreview] = useState<KioskSlide[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const settingsQ = useQuery({
    queryKey: ["kiosk-settings", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kiosk_settings")
        .select("display_mode, idle_seconds")
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw error;
      return {
        mode: (data?.display_mode === "slideshow" ? "slideshow" : "simple") as Mode,
        idle: data?.idle_seconds ?? DEFAULT_IDLE,
      };
    },
  });

  useEffect(() => {
    if (!settingsQ.data) return;
    setMode(settingsQ.data.mode);
    setIdle(String(settingsQ.data.idle));
  }, [settingsQ.data]);

  const slidesQ = useQuery({
    queryKey: ["kiosk-slides", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kiosk_slides")
        .select("id, kind, title, body, image_path, duration_seconds, enabled, position")
        .eq("company_id", companyId)
        .order("position")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as SlideRow[];
    },
  });
  const slides = slidesQ.data ?? [];

  const refreshSlides = () => void qc.invalidateQueries({ queryKey: ["kiosk-slides", companyId] });
  const onError = (e: Error) => setError(e.message);

  const idleNum = Number(idle);
  const idleValid = Number.isInteger(idleNum) && idleNum >= MIN_IDLE && idleNum <= MAX_IDLE;
  const dirty =
    !!settingsQ.data && (mode !== settingsQ.data.mode || idleNum !== settingsQ.data.idle);

  const saveSettings = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("kiosk_settings")
        .upsert({ company_id: companyId, display_mode: mode, idle_seconds: idleNum });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      void qc.invalidateQueries({ queryKey: ["kiosk-settings", companyId] });
    },
    onError,
  });

  const nextPosition = () => slides.reduce((m, s) => Math.max(m, s.position), 0) + 1;

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      let position = nextPosition();
      for (const file of files) {
        if (!IMAGE_TYPES.includes(file.type)) {
          throw new Error(t("{name} isn't a JPEG, PNG, WebP or GIF picture.", { name: file.name }));
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(t("{name} is larger than 10 MB.", { name: file.name }));
        }
        const ext =
          file.name
            .split(".")
            .pop()
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, "") || "img";
        const path = `${companyId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from(KIOSK_SLIDES_BUCKET)
          .upload(path, file, { contentType: file.type, cacheControl: "31536000" });
        if (upErr) throw upErr;
        const { error: insErr } = await supabase.from("kiosk_slides").insert({
          company_id: companyId,
          kind: "image",
          image_path: path,
          duration_seconds: DEFAULT_DURATION,
          position: position++,
        });
        if (insErr) {
          await supabase.storage.from(KIOSK_SLIDES_BUCKET).remove([path]);
          throw insErr;
        }
      }
    },
    onSuccess: () => setError(null),
    onError,
    onSettled: refreshSlides,
  });

  const saveMessage = useMutation({
    mutationFn: async (m: { id?: string; title: string; body: string; duration: number }) => {
      const fields = {
        title: m.title.trim() || null,
        body: m.body.trim() || null,
        duration_seconds: m.duration,
      };
      const { error } = m.id
        ? await supabase.from("kiosk_slides").update(fields).eq("id", m.id)
        : await supabase.from("kiosk_slides").insert({
            ...fields,
            company_id: companyId,
            kind: "message",
            position: nextPosition(),
          });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      setEditing(null);
      refreshSlides();
    },
    onError,
  });

  const updateSlide = useMutation({
    mutationFn: async (u: { id: string; enabled?: boolean; duration_seconds?: number }) => {
      const { id, ...fields } = u;
      const { error } = await supabase.from("kiosk_slides").update(fields).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => setError(null),
    onError,
    onSettled: refreshSlides,
  });

  const removeSlide = useMutation({
    mutationFn: async (s: SlideRow) => {
      const { error } = await supabase.from("kiosk_slides").delete().eq("id", s.id);
      if (error) throw error;
      // The row is what the device reads; a picture left behind is only clutter.
      if (s.image_path) await supabase.storage.from(KIOSK_SLIDES_BUCKET).remove([s.image_path]);
    },
    onSuccess: () => setError(null),
    onError,
    onSettled: refreshSlides,
  });

  const reorder = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.rpc("reorder_kiosk_slides", { _ids: ids });
      if (error) throw error;
    },
    onMutate: (ids) => {
      // Move it on screen straight away; the refetch settles it.
      qc.setQueryData<SlideRow[]>(["kiosk-slides", companyId], (old) =>
        old ? ids.map((id, i) => ({ ...old.find((s) => s.id === id)!, position: i + 1 })) : old,
      );
    },
    onSuccess: () => setError(null),
    onError,
    onSettled: refreshSlides,
  });

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= slides.length) return;
    const ids = slides.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  }

  const enabledSlides = slides.filter((s) => s.enabled);

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <MonitorPlay className="h-5 w-5 text-primary" /> {t("Display")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "What the shared clock-in shows. Every device picks up changes within a few minutes, or straight away when its page is reloaded.",
        )}
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {settingsQ.isLoading ? (
        <Loader2 className="mt-5 h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <div className="mt-5 space-y-5">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
            className="grid gap-3 sm:grid-cols-2"
          >
            <ModeOption
              value="simple"
              current={mode}
              title={t("Simple")}
              text={t("The keypad, always on screen.")}
            />
            <ModeOption
              value="slideshow"
              current={mode}
              title={t("Slideshow")}
              text={t(
                "Your slides play while nobody is using the clock. A touch, a key or a mouse move brings up the keypad.",
              )}
            />
          </RadioGroup>

          {mode === "slideshow" && (
            <div className="space-y-1.5">
              <Label htmlFor="kiosk-idle">{t("Back to the slideshow after (seconds)")}</Label>
              <Input
                id="kiosk-idle"
                type="number"
                inputMode="numeric"
                min={MIN_IDLE}
                max={MAX_IDLE}
                value={idle}
                onChange={(e) => setIdle(e.target.value)}
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                {idleValid
                  ? t("How long the keypad waits with nobody touching it.")
                  : t("Between {min} and {max} seconds.", { min: MIN_IDLE, max: MAX_IDLE })}
              </p>
              {enabledSlides.length === 0 && (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {t("No slides are switched on yet, so the device keeps showing the keypad.")}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={() => saveSettings.mutate()}
              disabled={!dirty || !idleValid || saveSettings.isPending}
            >
              {saveSettings.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
              {t("Save display")}
            </Button>
            {saved && <span className="text-sm text-muted-foreground">{t("Saved")}</span>}
          </div>
        </div>
      )}

      <div className="mt-8 border-t border-border pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-foreground">{t("Slides")}</h3>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) upload.mutate(files);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="mr-2 h-4 w-4" />
              )}
              {t("Upload picture")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <MessageSquarePlus className="mr-2 h-4 w-4" /> {t("Add message")}
            </Button>
            <Button
              size="sm"
              onClick={() => setPreview(enabledSlides)}
              disabled={enabledSlides.length === 0}
            >
              <Play className="mr-2 h-4 w-4" /> {t("Preview slideshow")}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Pictures or ads (JPEG, PNG, WebP or GIF, up to 10 MB) and information messages. They play top to bottom; each stays up for its own number of seconds.",
          )}
        </p>

        <div className="mt-4 space-y-2">
          {slidesQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {slidesQ.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("No slides yet.")}</p>
          )}
          {slides.map((s, i) => (
            <SlideItem
              key={s.id}
              slide={s}
              first={i === 0}
              last={i === slides.length - 1}
              busy={reorder.isPending}
              onUp={() => move(i, -1)}
              onDown={() => move(i, 1)}
              onToggle={(enabled) => updateSlide.mutate({ id: s.id, enabled })}
              onDuration={(duration_seconds) => updateSlide.mutate({ id: s.id, duration_seconds })}
              onEdit={() => setEditing(s)}
              onPreview={() => setPreview([s])}
              onRemove={() => {
                if (window.confirm(t("Delete this slide?"))) removeSlide.mutate(s);
              }}
            />
          ))}
        </div>
      </div>

      <MessageDialog
        slide={editing}
        saving={saveMessage.isPending}
        onClose={() => setEditing(null)}
        onSave={(m) => saveMessage.mutate(m)}
      />

      {preview && <SlideshowPreview slides={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

function ModeOption({
  value,
  current,
  title,
  text,
}: {
  value: Mode;
  current: Mode;
  title: string;
  text: string;
}) {
  const id = `kiosk-mode-${value}`;
  return (
    <Label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 font-normal ${
        current === value ? "border-primary bg-primary-soft" : "border-border"
      }`}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span>
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
      </span>
    </Label>
  );
}

function SlideItem({
  slide,
  first,
  last,
  busy,
  onUp,
  onDown,
  onToggle,
  onDuration,
  onEdit,
  onPreview,
  onRemove,
}: {
  slide: SlideRow;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onToggle: (enabled: boolean) => void;
  onDuration: (seconds: number) => void;
  onEdit: () => void;
  onPreview: () => void;
  onRemove: () => void;
}) {
  const t = useT("time");
  const [duration, setDuration] = useState(String(slide.duration_seconds));
  useEffect(() => setDuration(String(slide.duration_seconds)), [slide.duration_seconds]);

  function commitDuration() {
    const n = Number(duration);
    if (!Number.isInteger(n) || n < MIN_DURATION || n > MAX_DURATION) {
      setDuration(String(slide.duration_seconds));
      return;
    }
    if (n !== slide.duration_seconds) onDuration(n);
  }

  const label =
    slide.kind === "image"
      ? t("Picture")
      : slide.title?.trim() || slide.body?.trim().slice(0, 80) || t("Message");

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border border-border p-3 ${
        slide.enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-col">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onUp}
          disabled={first || busy}
          aria-label={t("Move up")}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onDown}
          disabled={last || busy}
          aria-label={t("Move down")}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      </div>

      {slide.kind === "image" && slide.image_path ? (
        <img
          src={kioskSlideImageUrl(slide.image_path)}
          alt=""
          loading="lazy"
          className="h-14 w-24 rounded-md bg-secondary object-cover"
        />
      ) : (
        <div className="flex h-14 w-24 items-center justify-center rounded-md bg-primary px-2 text-center text-[10px] font-semibold leading-tight text-primary-foreground">
          <span className="line-clamp-3">{slide.title || slide.body}</span>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">
          {slide.kind === "image" ? t("Picture") : t("Message")}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Input
            type="number"
            inputMode="numeric"
            min={MIN_DURATION}
            max={MAX_DURATION}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={commitDuration}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="h-8 w-16"
            aria-label={t("Seconds on screen")}
          />
          {t("sec")}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={slide.enabled}
            onCheckedChange={onToggle}
            aria-label={t("Show this slide")}
          />
          {slide.enabled ? t("Shown") : t("Hidden")}
        </label>
        <div className="flex">
          <Button variant="ghost" size="icon" onClick={onPreview} aria-label={t("Preview")}>
            <Eye className="h-4 w-4" />
          </Button>
          {slide.kind === "message" && (
            <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t("Edit")}>
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label={t("Delete")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageDialog({
  slide,
  saving,
  onClose,
  onSave,
}: {
  slide: SlideRow | "new" | null;
  saving: boolean;
  onClose: () => void;
  onSave: (m: { id?: string; title: string; body: string; duration: number }) => void;
}) {
  const t = useT("time");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [duration, setDuration] = useState(String(DEFAULT_DURATION));
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!slide) return;
    const s = slide === "new" ? null : slide;
    setTitle(s?.title ?? "");
    setBody(s?.body ?? "");
    setDuration(String(s?.duration_seconds ?? DEFAULT_DURATION));
  }, [slide]);

  const n = Number(duration);
  const durationValid = Number.isInteger(n) && n >= MIN_DURATION && n <= MAX_DURATION;
  const hasText = !!(title.trim() || body.trim());

  return (
    <>
      {/* Hidden, not closed, while the preview is up: a modal dialog would eat its taps. */}
      <Dialog open={!!slide && !previewing} onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{slide === "new" ? t("New message") : t("Edit message")}</DialogTitle>
            <DialogDescription>
              {t("A full-screen announcement on the clock-in device.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="slide-title">{t("Title")}</Label>
              <Input
                id="slide-title"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("e.g. Staff meeting Friday")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slide-body">{t("Text")}</Label>
              <Textarea
                id="slide-body"
                maxLength={1000}
                rows={5}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t("e.g. 3 pm in the break room. Coffee is on us.")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="slide-duration">{t("Seconds on screen")}</Label>
              <Input
                id="slide-duration"
                type="number"
                inputMode="numeric"
                min={MIN_DURATION}
                max={MAX_DURATION}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="w-24"
              />
              {!durationValid && (
                <p className="text-xs text-destructive">
                  {t("Between {min} and {max} seconds.", { min: MIN_DURATION, max: MAX_DURATION })}
                </p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setPreviewing(true)} disabled={!hasText}>
              <Eye className="mr-2 h-4 w-4" /> {t("Preview")}
            </Button>
            <Button
              onClick={() =>
                onSave({
                  id: slide && slide !== "new" ? slide.id : undefined,
                  title,
                  body,
                  duration: n,
                })
              }
              disabled={!hasText || !durationValid || saving}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {previewing && (
        <SlideshowPreview
          slides={[
            {
              id: "draft",
              kind: "message",
              title,
              body,
              image_path: null,
              duration_seconds: durationValid ? n : DEFAULT_DURATION,
            },
          ]}
          onClose={() => setPreviewing(false)}
        />
      )}
    </>
  );
}

/** The device's own slideshow, full screen; a tap or Escape closes it. */
function SlideshowPreview({ slides, onClose }: { slides: KioskSlide[]; onClose: () => void }) {
  const t = useT("time");
  const ready = usePreloadedSlideImages(slides);
  const playable = playableSlides(slides, ready);
  const waiting = slides.some((s) => s.kind === "image") && playable.length < slides.length;

  if (playable.length === 0) {
    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black text-white"
        onClick={onClose}
      >
        {waiting ? <Loader2 className="h-8 w-8 animate-spin" /> : t("Nothing to show.")}
      </div>
    );
  }
  // z-[60] so it sits above the message dialog it can be opened from.
  return (
    <div className="fixed inset-0 z-[60]">
      <KioskSlideshow slides={playable} onWake={onClose} wakeOnMove={false} />
    </div>
  );
}
