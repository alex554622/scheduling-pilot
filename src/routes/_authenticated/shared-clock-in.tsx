import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clock,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  ScanFace,
  Tablet,
  Trash2,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocaleTag, useT } from "@/lib/i18n";
import { shareableOrigin } from "@/lib/native/platform";
import { KioskDisplaySettings } from "@/components/kiosk-display-settings";
import { FaceEnrollDialog } from "@/components/face-enroll-dialog";

/**
 * Set-up screen for the shared clock-in device: the link a tablet is opened
 * once with, and the 4-digit code each employee types on it. The device itself
 * (src/routes/clock.$token.tsx) holds no account, so this page is the only
 * place a link is issued or taken away.
 */
export const Route = createFileRoute("/_authenticated/shared-clock-in")({
  component: SharedClockInAdminPage,
});

type DeviceRow = {
  id: string;
  label: string;
  token: string;
  created_at: string;
  last_used_at: string | null;
};

function SharedClockInAdminPage() {
  const t = useT("time");
  const tag = useLocaleTag();
  const { company, primaryRole } = useAuth();
  const qc = useQueryClient();
  const isAdmin = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [label, setLabel] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const devicesQ = useQuery({
    queryKey: ["kiosk-devices", company?.id],
    enabled: !!company?.id && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("kiosk_devices")
        .select("id, label, token, created_at, last_used_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as DeviceRow[];
    },
  });

  const staffQ = useQuery({
    queryKey: ["clock-codes", company?.id],
    enabled: !!company?.id && isAdmin,
    queryFn: async () => {
      const [{ data: people, error: peopleError }, { data: codes, error: codesError }] =
        await Promise.all([
          supabase
            .from("company_members")
            .select("id, full_name")
            .eq("company_id", company!.id)
            .order("full_name"),
          supabase.from("employee_clock_codes").select("user_id, code"),
        ]);
      if (peopleError) throw peopleError;
      if (codesError) throw codesError;
      const byUser = new Map((codes ?? []).map((c) => [c.user_id, c.code]));
      return (people ?? []).map((p) => ({
        id: p.id,
        name: p.full_name || t("Unnamed"),
        code: byUser.get(p.id) ?? null,
      }));
    },
  });

  const createDevice = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("create_kiosk_device", {
        _label: label.trim() || "Shared clock-in",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setLabel("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["kiosk-devices"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const revokeDevice = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("revoke_kiosk_device", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["kiosk-devices"] }),
    onError: (e: Error) => setError(e.message),
  });

  // No code: the server picks a random free one. A code: exactly that one.
  const setCode = useMutation({
    mutationFn: async ({ userId, code }: { userId: string; code?: string }) => {
      const { error } = await supabase.rpc("set_employee_clock_code", {
        _user: userId,
        ...(code ? { _code: code } : {}),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["clock-codes"] });
    },
    onError: (e: Error) =>
      setError(
        e.message.includes("already used by someone else")
          ? t("That code is already someone else's. Choose another one.")
          : e.message.includes("exactly 4 digits")
            ? t("The code must be exactly 4 digits.")
            : e.message,
      ),
  });
  // Whose PIN is being typed in, and what has been typed so far.
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const clearCode = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("clear_employee_clock_code", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clock-codes"] }),
    onError: (e: Error) => setError(e.message),
  });

  // Face clock-in: who is approved or waiting (never the face data itself).
  const facesQ = useQuery({
    queryKey: ["face-enrollment", company?.id],
    enabled: !!company?.id && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("face_enrollment_status");
      if (error) throw error;
      // Before 20261130120000 runs, rows have no `approved`: they are all approved.
      return new Map(
        (data ?? []).map((r) => [r.user_id, { ...r, approved: r.approved ?? true }]),
      );
    },
  });
  const [enrolling, setEnrolling] = useState<{ id: string; name: string } | null>(null);
  const waiting = [...(facesQ.data?.values() ?? [])].filter((f) => f.pending_at).length;

  const faceAction = useMutation({
    mutationFn: async ({
      userId,
      action,
    }: {
      userId: string;
      action: "clear_employee_face" | "approve_employee_face" | "reject_employee_face";
    }) => {
      const { error } = await supabase.rpc(action, { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["face-enrollment"] });
    },
    onError: (e: Error) => {
      const similar = e.message.match(/too similar to (.+) \(already enrolled\)/);
      setError(
        similar
          ? t(
              "This face is too similar to {name}, who is already enrolled. Each person can only be enrolled once.",
              { name: similar[1] },
            )
          : e.message,
      );
    },
  });

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError(t("Couldn't copy — select the link and copy it by hand."));
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Only a company admin can set up the shared clock-in.")}
      </p>
    );
  }

  const origin = typeof window === "undefined" ? "" : shareableOrigin();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("Shared clock-in")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "One tablet or computer that everyone punches in on. The device is signed in to nobody: it can only clock people in and out, so nothing on it reaches your account.",
          )}
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Tablet className="h-5 w-5 text-primary" /> {t("Devices")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Open a device's link once on that tablet, then leave the page open. Anyone with the link can clock staff in and out, so treat it like a key: if a tablet goes missing, remove its link here and make a new one.",
          )}
        </p>

        <div className="mt-5 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="device-label">{t("Where is it? (optional)")}</Label>
            <Input
              id="device-label"
              placeholder={t("e.g. Front desk")}
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-56"
            />
          </div>
          <Button onClick={() => createDevice.mutate()} disabled={createDevice.isPending}>
            {createDevice.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
            {t("Create device link")}
          </Button>
        </div>

        <div className="mt-5 space-y-3">
          {devicesQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {devicesQ.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("No devices yet. Create one above.")}
            </p>
          )}
          {devicesQ.data?.map((d) => {
            const link = `${origin}/clock/${d.token}`;
            return (
              <div key={d.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-foreground">{d.label}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revokeDevice.mutate(d.id)}
                    disabled={revokeDevice.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> {t("Remove link")}
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
                    {link}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => void copy(link, d.id)}>
                    {copied === d.id ? (
                      <Check className="mr-2 h-4 w-4" />
                    ) : (
                      <Copy className="mr-2 h-4 w-4" />
                    )}
                    {copied === d.id ? t("Copied") : t("Copy link")}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {d.last_used_at
                    ? t("Last used {when}", { when: new Date(d.last_used_at).toLocaleString(tag) })
                    : t("Not used yet")}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {company?.id && <KioskDisplaySettings companyId={company.id} />}

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="text-lg font-semibold text-foreground">{t("Face and PIN")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "On the shared device people clock in by looking at the camera. Enroll each person's face here, from a device with a camera, with them in front of it. Their 4-digit PIN is the backup: give someone a new PIN any time and the old one stops working straight away.",
          )}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "No photos are kept: only a set of numbers describing the face, which can't be turned back into a picture and which only the clock-in can use. Remove someone's face at any time.",
          )}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "Employees can also scan their own face from Settings → My account. Their scan isn't used until you approve it here, and the same goes for every change. Before approving, make sure the person really did the scan themselves.",
          )}
        </p>
        {waiting > 0 && (
          <p className="mt-3 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800">
            <Clock className="h-4 w-4" />
            {waiting === 1
              ? t("1 face is waiting for your approval.")
              : t("{n} faces are waiting for your approval.", { n: waiting })}
          </p>
        )}

        <div className="mt-5 divide-y divide-border">
          {staffQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {staffQ.data?.map((p) => {
            const face = facesQ.data?.get(p.id);
            const isEditing = editing?.id === p.id;
            return (
              <div key={p.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{p.name}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {face?.approved ? (
                      <span className="flex items-center gap-1">
                        <span className="flex items-center gap-1 rounded-md bg-emerald-600/10 px-2 py-1 text-sm font-medium text-emerald-700">
                          <ScanFace className="h-4 w-4" /> {t("Face enrolled")}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEnrolling({ id: p.id, name: p.name })}
                        >
                          {t("Redo")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            faceAction.mutate({ userId: p.id, action: "clear_employee_face" })
                          }
                          disabled={faceAction.isPending}
                          aria-label={t("Remove {name}'s face", { name: p.name })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    ) : (
                      !face?.pending_at && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEnrolling({ id: p.id, name: p.name })}
                          disabled={facesQ.isLoading}
                        >
                          <ScanFace className="mr-2 h-4 w-4" /> {t("Enroll face")}
                        </Button>
                      )
                    )}
                    {isEditing ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          setCode.mutate({ userId: p.id, code: editing.value });
                        }}
                      >
                        <Input
                          autoFocus
                          inputMode="numeric"
                          pattern="[0-9]{4}"
                          maxLength={4}
                          value={editing.value}
                          onChange={(e) =>
                            setEditing({
                              id: p.id,
                              value: e.target.value.replace(/\D/g, "").slice(0, 4),
                            })
                          }
                          aria-label={t("{name}'s code", { name: p.name })}
                          className="w-24 text-center font-mono text-lg tracking-widest"
                          placeholder="0000"
                        />
                        <Button
                          type="submit"
                          size="sm"
                          disabled={editing.value.length !== 4 || setCode.isPending}
                        >
                          {setCode.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                          <span className="ml-1">{t("Save")}</span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(null)}
                          aria-label={t("Cancel")}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span
                          className={`rounded-md px-3 py-1.5 font-mono text-lg tracking-widest ${
                            p.code ? "bg-primary-soft text-primary" : "text-muted-foreground"
                          }`}
                        >
                          {p.code ?? "— — — —"}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditing({ id: p.id, value: p.code ?? "" })}
                        >
                          <Pencil className="mr-2 h-4 w-4" />{" "}
                          {p.code ? t("Change code") : t("Set code")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCode.mutate({ userId: p.id })}
                          disabled={setCode.isPending}
                          title={t("Pick a random code")}
                          aria-label={t("Pick a random code for {name}", { name: p.name })}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {p.code && !isEditing && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => clearCode.mutate(p.id)}
                        disabled={clearCode.isPending}
                        aria-label={t("Remove {name}'s code", { name: p.name })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
                {face?.pending_at && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                    <div className="text-sm">
                      <p className="flex items-center gap-1 font-medium text-amber-800">
                        <Clock className="h-4 w-4" />
                        {face.approved
                          ? t(
                              "{name} scanned a new face on {when}. It's waiting for your approval.",
                              {
                                name: p.name,
                                when: new Date(face.pending_at).toLocaleString(tag),
                              },
                            )
                          : t(
                              "{name} scanned their face on {when}. It's waiting for your approval.",
                              {
                                name: p.name,
                                when: new Date(face.pending_at).toLocaleString(tag),
                              },
                            )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {face.matches_current === true
                          ? t("It looks like the face already approved for them.")
                          : face.matches_current === false
                            ? t(
                                "It does NOT look like the face already approved for them. Check with {name} before approving.",
                                { name: p.name },
                              )
                            : t(
                                "This is their first face. Check with {name} that they did the scan themselves.",
                                { name: p.name },
                              )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          faceAction.mutate({ userId: p.id, action: "reject_employee_face" })
                        }
                        disabled={faceAction.isPending}
                      >
                        <X className="mr-1 h-4 w-4" /> {t("Reject")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          faceAction.mutate({ userId: p.id, action: "approve_employee_face" })
                        }
                        disabled={faceAction.isPending}
                      >
                        <Check className="mr-1 h-4 w-4" /> {t("Approve")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {staffQ.data?.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">{t("No employees yet.")}</p>
          )}
        </div>
      </section>

      <FaceEnrollDialog
        person={enrolling}
        onClose={() => setEnrolling(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["face-enrollment"] })}
      />
    </div>
  );
}
