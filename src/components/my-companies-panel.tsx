import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Loader2, LogOut, Search, Send, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, roleLabel, type Membership } from "@/lib/auth";
import { useLocaleTag, useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface LookupResult {
  ok: boolean;
  message?: string;
  company_id?: string;
  name?: string;
  membership?: string | null;
  pending?: boolean;
}

interface JoinRequestRow {
  id: string;
  company_id: string;
  company_name: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  message: string | null;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

const ROLE_ORDER = ["company_admin", "supervisor", "employee"];

function roleText(m: Membership, t: (s: string) => string) {
  const role = ROLE_ORDER.find((r) => m.roles.includes(r));
  if (!role) return t("No role yet");
  return role === "supervisor" ? t("Supervisor") : roleLabel(role);
}

/**
 * Settings → My companies. Every company this account belongs to, joining
 * another by its code (an admin there still has to approve), the requests
 * sent so far, and leaving a company.
 */
export function MyCompaniesPanel() {
  const { company, memberships, switchCompany, refresh, ghost } = useAuth();
  const t = useT("shell");
  const localeTag = useLocaleTag();
  const qc = useQueryClient();

  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [found, setFound] = useState<LookupResult | null>(null);

  const requestsQ = useQuery({
    queryKey: ["my-join-requests"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_join_requests");
      if (error) throw error;
      return (data ?? []) as JoinRequestRow[];
    },
  });

  const lookup = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("lookup_company_code", { _code: code.trim() });
      if (error) throw error;
      return data as unknown as LookupResult;
    },
    onSuccess: (r) => setFound(r),
    onError: (e: unknown) =>
      setFound({ ok: false, message: e instanceof Error ? e.message : String(e) }),
  });

  const send = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("request_to_join", {
        _code: code.trim(),
        _message: message.trim() || undefined,
      });
      if (error) throw error;
      const r = data as unknown as LookupResult;
      if (!r.ok) throw new Error(r.message ?? t("That company code is not valid."));
      return r;
    },
    onSuccess: (r) => {
      toast.success(
        t("Request sent to {name}. An admin there has to approve it.", { name: r.name ?? "" }),
      );
      setCode("");
      setMessage("");
      setFound(null);
      void qc.invalidateQueries({ queryKey: ["my-join-requests"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_join_request", { _request: id });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-join-requests"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const leave = useMutation({
    mutationFn: async (companyId: string) => {
      const { error } = await supabase.rpc("leave_company", { _company: companyId });
      if (error) throw error;
      return companyId;
    },
    onSuccess: async (companyId) => {
      if (companyId === company?.id) {
        // Everything on screen belongs to the company just left: start clean.
        window.location.assign("/dashboard");
        return;
      }
      toast.success(t("You left the company."));
      await refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const statusBadge: Record<JoinRequestRow["status"], string> = {
    pending: "bg-warning/15 text-warning-foreground",
    approved: "bg-primary-soft text-primary",
    rejected: "bg-destructive/10 text-destructive",
    cancelled: "bg-muted text-muted-foreground",
  };
  const statusLabel: Record<JoinRequestRow["status"], string> = {
    pending: t("Waiting for approval"),
    approved: t("Approved"),
    rejected: t("Declined"),
    cancelled: t("Cancelled"),
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h3 className="font-semibold text-foreground">{t("Your companies")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Each company keeps its own role, schedule, time cards and time off. Switch between them from the menu at the top.",
          )}
        </p>
        {memberships.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {t("You don't belong to a company yet.")}
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {memberships.map((m) => {
              const current = m.companyId === company?.id && !ghost;
              return (
                <li
                  key={m.companyId}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {m.name}
                        {current && (
                          <span className="ml-2 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
                            {t("Current")}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {m.status === "suspended" ? t("Suspended") : roleText(m, t)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!current && m.status === "active" && m.companyStatus === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void switchCompany(m.companyId)}
                      >
                        {t("Switch")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={leave.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            t(
                              "Leave {name}? You lose access to its schedule, time cards and time off. Your account and your other companies stay as they are.",
                              {
                                name: m.name,
                              },
                            ),
                          )
                        )
                          leave.mutate(m.companyId);
                      }}
                    >
                      {leave.isPending && leave.variables === m.companyId ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LogOut className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {t("Leave")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h3 className="font-semibold text-foreground">{t("Join another company")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Enter the company code an admin gave you. The code only sends a request — an admin of that company has to approve it.",
          )}
        </p>
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) lookup.mutate();
          }}
        >
          <div className="flex-1">
            <Label htmlFor="company-code" className="sr-only">
              {t("Company code")}
            </Label>
            <Input
              id="company-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setFound(null);
              }}
              placeholder={t("Company code")}
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={32}
              className="font-mono tracking-widest"
            />
          </div>
          <Button type="submit" variant="outline" disabled={!code.trim() || lookup.isPending}>
            {lookup.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-1.5 h-4 w-4" />
            )}
            {t("Find company")}
          </Button>
        </form>

        {found && !found.ok && <p className="mt-3 text-sm text-destructive">{found.message}</p>}
        {found?.ok && (
          <div className="mt-4 space-y-3 rounded-lg border border-border p-4">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {found.name}
            </p>
            {found.membership === "active" ? (
              <p className="text-sm text-muted-foreground">
                {t("You are already a member of this company.")}
              </p>
            ) : found.membership === "suspended" ? (
              <p className="text-sm text-muted-foreground">
                {t("Your membership in this company is suspended. Ask one of its admins.")}
              </p>
            ) : found.pending ? (
              <p className="text-sm text-muted-foreground">
                {t("Your request is already waiting for approval.")}
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="join-message">{t("Message for the admins (optional)")}</Label>
                  <Textarea
                    id="join-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={500}
                    rows={2}
                    placeholder={t("Who you are, which team you work in…")}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => send.mutate()} disabled={send.isPending}>
                    {send.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-1.5 h-4 w-4" />
                    )}
                    {t("Send join request")}
                  </Button>
                  <Button variant="ghost" onClick={() => setFound(null)}>
                    {t("Cancel")}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h3 className="font-semibold text-foreground">{t("Your join requests")}</h3>
        {requestsQ.isLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("Loading…")}</p>
        ) : (requestsQ.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("No requests yet.")}</p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {(requestsQ.data ?? []).map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{r.company_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("Sent {date}", {
                      date: new Date(r.created_at).toLocaleDateString(localeTag),
                    })}
                    {r.decision_note ? ` · ${r.decision_note}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge[r.status]}`}
                  >
                    {r.status === "approved" && <Check className="mr-1 inline h-3 w-3" />}
                    {statusLabel[r.status]}
                  </span>
                  {r.status === "pending" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(r.id)}
                    >
                      <X className="mr-1 h-3.5 w-3.5" />
                      {t("Cancel request")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
