import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Fingerprint, Loader2, Tablet, Trash2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocaleTag, useT } from "@/lib/i18n";
import { shareableOrigin } from "@/lib/native/platform";
import {
  fingerprintStatus,
  registerFingerprint,
  removeFingerprint,
  updateFingerprintCode,
  type FingerprintStatus,
} from "@/lib/native/fingerprint";
import { KioskDisplaySettings } from "@/components/kiosk-display-settings";

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

  // Fingerprints, on the Android app with Pilot Clock (the reader's driver)
  // installed. They live on this tablet only, so the controls only appear here.
  const [fp, setFp] = useState<FingerprintStatus | null>(null);
  const [fpBusy, setFpBusy] = useState<string | null>(null);
  const refreshFp = useCallback(() => {
    void fingerprintStatus().then(setFp);
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    refreshFp();
    // Coming back to the app (e.g. after plugging the reader in) re-checks.
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshFp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isAdmin, refreshFp]);
  const hasFingerprint = (userId: string) => fp?.enrolled.includes(userId) ?? false;

  async function register(p: { id: string; name: string; code: string }) {
    setFpBusy(p.id);
    setError(null);
    const r = await registerFingerprint(p.id, p.name, p.code);
    setFpBusy(null);
    if (!r.ok && r.error && r.error !== "Cancelled") setError(t(r.error));
    refreshFp();
  }

  async function unregister(userId: string) {
    setFpBusy(userId);
    setError(null);
    const r = await removeFingerprint(userId);
    setFpBusy(null);
    if (!r.ok && r.error) setError(t(r.error));
    refreshFp();
  }

  const setCode = useMutation({
    mutationFn: async (userId: string) => {
      const { data, error } = await supabase.rpc("set_employee_clock_code", { _user: userId });
      if (error) throw error;
      return { userId, code: data };
    },
    onSuccess: async ({ userId, code }) => {
      // A registered fingerprint follows the person to their new code, so the
      // old code stops working by fingerprint too.
      if (hasFingerprint(userId)) {
        const r = await updateFingerprintCode(userId, code);
        if (!r.ok) setError(t("The new code is saved, but the fingerprint could not be updated. Register the fingerprint again."));
      }
      void qc.invalidateQueries({ queryKey: ["clock-codes"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const clearCode = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("clear_employee_clock_code", { _user: userId });
      if (error) throw error;
      return userId;
    },
    onSuccess: async (userId) => {
      // Without a code a fingerprint has nothing to clock in with.
      if (hasFingerprint(userId)) await unregister(userId);
      void qc.invalidateQueries({ queryKey: ["clock-codes"] });
    },
    onError: (e: Error) => setError(e.message),
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
          {t("One tablet or computer that everyone punches in on. The device is signed in to nobody: it can only clock people in and out, so nothing on it reaches your account.")}
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
          {t("Open a device's link once on that tablet, then leave the page open. Anyone with the link can clock staff in and out, so treat it like a key: if a tablet goes missing, remove its link here and make a new one.")}
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
            {createDevice.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t("Create device link")}
          </Button>
        </div>

        <div className="mt-5 space-y-3">
          {devicesQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {devicesQ.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("No devices yet. Create one above.")}</p>
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
        <h2 className="text-lg font-semibold text-foreground">{t("Employee codes")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Each person types their own 4-digit code on the shared device. Give someone a new code any time; the old one stops working straight away.")}
        </p>

        {fp?.installed && (
          <div
            className={`mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${
              fp.readerAttached ? "bg-primary-soft text-primary" : "bg-secondary text-muted-foreground"
            }`}
          >
            <span className="flex items-center gap-2">
              <Fingerprint className="h-5 w-5" />
              {fp.readerAttached
                ? t("Fingerprint reader connected. Register a fingerprint for each person who has a code; they can then clock in with it on this tablet's shared clock-in.")
                : t("No fingerprint reader found. Plug it into this tablet to register fingerprints.")}
            </span>
            <Button variant="outline" size="sm" onClick={refreshFp}>
              <RefreshCw className="mr-2 h-4 w-4" /> {t("Check again")}
            </Button>
          </div>
        )}
        {fp?.error && <p className="mt-2 text-sm text-destructive">{t(fp.error)}</p>}

        <div className="mt-5 divide-y divide-border">
          {staffQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {staffQ.data?.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="font-medium text-foreground">{p.name}</span>
              <div className="flex flex-wrap items-center gap-2">
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
                  onClick={() => setCode.mutate(p.id)}
                  disabled={setCode.isPending}
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> {p.code ? t("New code") : t("Give code")}
                </Button>
                {p.code && (
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
                {fp?.installed &&
                  (hasFingerprint(p.id) ? (
                    <span className="flex items-center gap-1">
                      <span className="flex items-center gap-1 rounded-md bg-emerald-600/10 px-2 py-1 text-sm font-medium text-emerald-700">
                        <Fingerprint className="h-4 w-4" /> {t("Fingerprint")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void unregister(p.id)}
                        disabled={fpBusy !== null}
                        aria-label={t("Remove {name}'s fingerprint", { name: p.name })}
                      >
                        {fpBusy === p.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => p.code && void register({ id: p.id, name: p.name, code: p.code })}
                      disabled={!p.code || !fp.readerAttached || fpBusy !== null}
                      title={!p.code ? t("Give a code first") : undefined}
                    >
                      {fpBusy === p.id ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Fingerprint className="mr-2 h-4 w-4" />
                      )}
                      {t("Register fingerprint")}
                    </Button>
                  ))}
              </div>
            </div>
          ))}
          {staffQ.data?.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">{t("No employees yet.")}</p>
          )}
        </div>
      </section>
    </div>
  );
}
