import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Loader2, Tablet, Trash2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
            .from("profiles")
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
        name: p.full_name || "Unnamed",
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

  const setCode = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("set_employee_clock_code", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clock-codes"] }),
    onError: (e: Error) => setError(e.message),
  });

  const clearCode = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("clear_employee_clock_code", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clock-codes"] }),
    onError: (e: Error) => setError(e.message),
  });

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't copy — select the link and copy it by hand.");
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        Only a company admin can set up the shared clock-in.
      </p>
    );
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Shared clock-in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One tablet or computer that everyone punches in on. The device is signed in to nobody: it
          can only clock people in and out, so nothing on it reaches your account.
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Tablet className="h-5 w-5 text-primary" /> Devices
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a device's link once on that tablet, then leave the page open. Anyone with the link
          can clock staff in and out, so treat it like a key: if a tablet goes missing, remove its
          link here and make a new one.
        </p>

        <div className="mt-5 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="device-label">Where is it? (optional)</Label>
            <Input
              id="device-label"
              placeholder="e.g. Front desk"
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-56"
            />
          </div>
          <Button onClick={() => createDevice.mutate()} disabled={createDevice.isPending}>
            {createDevice.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Create device
            link
          </Button>
        </div>

        <div className="mt-5 space-y-3">
          {devicesQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {devicesQ.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">No devices yet. Create one above.</p>
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
                    <Trash2 className="mr-2 h-4 w-4" /> Remove link
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
                    {copied === d.id ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {d.last_used_at
                    ? `Last used ${new Date(d.last_used_at).toLocaleString()}`
                    : "Not used yet"}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="text-lg font-semibold text-foreground">Employee codes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each person types their own 4-digit code on the shared device. Give someone a new code any
          time; the old one stops working straight away.
        </p>

        <div className="mt-5 divide-y divide-border">
          {staffQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
          {staffQ.data?.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="font-medium text-foreground">{p.name}</span>
              <div className="flex items-center gap-2">
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
                  <RefreshCw className="mr-2 h-4 w-4" /> {p.code ? "New code" : "Give code"}
                </Button>
                {p.code && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => clearCode.mutate(p.id)}
                    disabled={clearCode.isPending}
                    aria-label={`Remove ${p.name}'s code`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
          {staffQ.data?.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">No employees yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
