import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2, ScanFace, ShieldCheck, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { FaceEnrollDialog } from "@/components/face-enroll-dialog";
import { useLocaleTag, useT } from "@/lib/i18n";

type MyFace = {
  approved: boolean;
  approved_at: string | null;
  pending: boolean;
  submitted_at: string | null;
};

/**
 * My account: the signed-in person sets up (or changes) their own face for
 * the shared clock-in. A new or changed face waits for an admin to approve it
 * on the Shared clock-in page; until then any approved face keeps working.
 */
export function MyFaceCard() {
  const t = useT("time");
  const tag = useLocaleTag();
  const { user, profile, company } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["my-face", user?.id, company?.id],
    enabled: !!user?.id && !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_face_status");
      if (error) throw error;
      return (data ?? null) as MyFace | null;
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("remove_my_face");
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["my-face"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  // Not in a company (or the database isn't migrated yet): nothing to set up.
  if (!company?.id || q.isError || (q.isSuccess && !q.data)) return null;
  const s = q.data;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(tag) : "");

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex items-center gap-2">
        <ScanFace className="h-5 w-5 text-primary" />
        <h3 className="font-semibold text-foreground">{t("Face clock-in")}</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          "Clock in on your company's shared clock-in by looking at the camera. No photo is kept, only a set of numbers describing your face. An admin approves it before it can be used, and again every time you change it.",
        )}
      </p>

      {q.isLoading && <Loader2 className="mt-4 h-5 w-5 animate-spin text-muted-foreground" />}

      {s && (
        <div className="mt-4 space-y-2">
          {s.approved && (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <ShieldCheck className="h-4 w-4" />
              {t("Your face is approved. You can clock in with it. (Since {when})", {
                when: when(s.approved_at),
              })}
            </p>
          )}
          {s.pending && (
            <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
              <Clock className="h-4 w-4" />
              {s.approved
                ? t(
                    "Your new face scan is waiting for an admin to approve it. Until then your current one keeps working.",
                  )
                : t(
                    "Your face scan is waiting for an admin to approve it. Use your PIN until then.",
                  )}
            </p>
          )}
          {!s.approved && !s.pending && (
            <p className="text-sm text-muted-foreground">
              {t("You haven't set up face clock-in.")}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {s && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {(s.approved || s.pending) && (
            <Button variant="outline" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t("Remove my face")}
            </Button>
          )}
          <Button onClick={() => setOpen(true)}>
            <ScanFace className="mr-2 h-4 w-4" />
            {s.approved || s.pending ? t("Scan my face again") : t("Set up face clock-in")}
          </Button>
        </div>
      )}

      <FaceEnrollDialog
        self
        person={open && user ? { id: user.id, name: profile?.full_name || t("you") } : null}
        onClose={() => setOpen(false)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["my-face"] })}
      />
    </div>
  );
}
