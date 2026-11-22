import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, roleLabel } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocaleTag, useT } from "@/lib/i18n";
import { useOrgStructure } from "@/lib/use-org-structure";
import { activeOrCurrent, positionFitsDepartment, positionsForDepartment } from "@/lib/org-structure";
import {
  Loader2,
  UserCheck,
  UserX,
  ArrowLeft,
  Inbox,
  Copy,
  RefreshCw,
  KeyRound,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees/join-requests")({
  component: MembershipRequestsPage,
});

type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
type GrantRole = "employee" | "company_admin";
const GRANT_ROLES: GrantRole[] = ["employee", "company_admin"];
const NONE = "__none__";

interface RequestRow {
  id: string;
  user_id: string;
  full_name: string;
  message: string | null;
  status: RequestStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
}

function MembershipRequestsPage() {
  const t = useT("people");
  const localeTag = useLocaleTag();
  const { primaryRole, company, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const companyId = company?.id ?? null;
  const [deciding, setDeciding] = useState<{ row: RequestRow; approve: boolean } | null>(null);

  useEffect(() => {
    if (!loading && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  const requestsQ = useQuery({
    queryKey: ["company-join-requests", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("company_join_requests")
        .select("id, user_id, message, status, created_at, decided_at, decision_note")
        .eq("company_id", companyId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
      const names = new Map<string, string>();
      if (ids.length > 0) {
        const { data: people, error: pErr } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", ids);
        if (pErr) throw pErr;
        for (const p of people ?? []) names.set(p.id, p.full_name);
      }
      return (rows ?? []).map((r) => ({
        ...r,
        status: r.status as RequestStatus,
        full_name: names.get(r.user_id) ?? "",
      })) as RequestRow[];
    },
  });

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;

  const all = requestsQ.data ?? [];
  const pending = all.filter((r) => r.status === "pending");
  const decided = all.filter((r) => r.status !== "pending").slice(0, 20);

  const statusLabel: Record<RequestStatus, string> = {
    pending: t("Pending"),
    approved: t("Approved"),
    rejected: t("Declined"),
    cancelled: t("Withdrawn"),
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          to="/employees"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t("Back to employees")}
        </Link>
        <h2 className="text-2xl font-semibold text-foreground">{t("Membership requests")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "People who asked to join {company} with its company code. Nobody gets in until an admin approves.",
            {
              company: company?.name ?? t("your company"),
            },
          )}
        </p>
      </div>

      <CompanyCodeCard />

      <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2 border-b border-border px-4 py-4 sm:px-5">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">
            {t("Pending")} ({requestsQ.isLoading ? "…" : pending.length})
          </h3>
        </div>

        {requestsQ.isLoading ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">{t("Loading…")}</p>
        ) : pending.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Inbox className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">{t("No pending join requests.")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((r) => {
              const initials = (r.full_name || "?")
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              return (
                <li
                  key={r.id}
                  className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                      {initials || "?"}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {r.full_name || t("Unnamed user")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("Asked {date}", {
                          date: new Date(r.created_at).toLocaleDateString(localeTag),
                        })}
                      </p>
                      {r.message && (
                        <p className="mt-1 whitespace-pre-line break-words text-sm text-foreground/80">
                          “{r.message}”
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 sm:shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-none"
                      onClick={() => setDeciding({ row: r, approve: false })}
                    >
                      <UserX className="h-4 w-4" />
                      {t("Reject")}
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1 sm:flex-none"
                      onClick={() => setDeciding({ row: r, approve: true })}
                    >
                      <UserCheck className="h-4 w-4" />
                      {t("Approve")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {requestsQ.error && (
          <p className="border-t border-border px-5 py-3 text-sm text-destructive">
            {(requestsQ.error as Error).message}
          </p>
        )}
      </div>

      {decided.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <h3 className="text-sm font-semibold text-foreground">{t("Recently answered")}</h3>
          </div>
          <ul className="divide-y divide-border">
            {decided.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {r.full_name || t("Unnamed user")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(r.decided_at ?? r.created_at).toLocaleDateString(localeTag)}
                    {r.decision_note ? ` · ${r.decision_note}` : ""}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {statusLabel[r.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {deciding && companyId && (
        <DecideDialog
          row={deciding.row}
          approve={deciding.approve}
          companyId={companyId}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            void qc.invalidateQueries({ queryKey: ["company-join-requests", companyId] });
            void qc.invalidateQueries({ queryKey: ["company-members", companyId] });
            void qc.invalidateQueries({ queryKey: ["company-roles", companyId] });
          }}
        />
      )}
    </div>
  );
}

function DecideDialog({
  row,
  approve,
  companyId,
  onClose,
  onDone,
}: {
  row: RequestRow;
  approve: boolean;
  companyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT("people");
  const [role, setRole] = useState<GrantRole>("employee");
  const [department, setDepartment] = useState(NONE);
  const [position, setPosition] = useState(NONE);
  const [note, setNote] = useState("");

  // Active departments, and the positions of the one picked.
  const org = useOrgStructure(companyId, approve);
  const pickedDepartment = department === NONE ? null : department;
  const departmentOptions = activeOrCurrent(org.departments);
  const positionOptions = positionsForDepartment(pickedDepartment, org.positions, org.links);

  const decide = useMutation({
    mutationFn: async () => {
      const pos = org.positions.find((x) => x.id === position);
      const { error } = await supabase.rpc("decide_join_request", {
        _request: row.id,
        _approve: approve,
        _role: approve ? role : undefined,
        _department: approve && department !== NONE ? department : undefined,
        _position_id: approve && pos ? pos.id : undefined,
        _position: approve && pos ? pos.name : undefined,
        _note: note.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        approve
          ? t("{name} can now use this company.", { name: row.full_name || t("They") })
          : t("Request declined."),
      );
      onDone();
    },
  });

  const name = row.full_name || t("Unnamed user");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {approve ? t("Approve {name}", { name }) : t("Decline {name}", { name })}
          </DialogTitle>
          <DialogDescription>
            {approve
              ? t("Choose what they can do here. You can change it later on the Employees page.")
              : t("They will be told the request was declined. They can ask again later.")}
          </DialogDescription>
        </DialogHeader>

        {approve && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("Role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as GrantRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANT_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {role === "company_admin" && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Admins can see everyone's schedule and time cards and change company settings.",
                  )}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t("Department")}</Label>
              <Select
                value={department}
                onValueChange={(v) => {
                  setDepartment(v);
                  if (position !== NONE && !positionFitsDepartment(position, v === NONE ? null : v, org.links))
                    setPosition(NONE);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("No department")}</SelectItem>
                  {departmentOptions.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("Position")}</Label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("No position")}</SelectItem>
                  {positionOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="decision-note">{t("Note to them (optional)")}</Label>
          <Textarea
            id="decision-note"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {decide.error && (
          <p className="text-sm text-destructive">{(decide.error as Error).message}</p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={decide.isPending}>
            {t("Cancel")}
          </Button>
          <Button
            variant={approve ? "default" : "destructive"}
            onClick={() => decide.mutate()}
            disabled={decide.isPending}
          >
            {decide.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {approve ? t("Approve") : t("Decline")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The company code people use to ask to join, and the membership rules. */
function CompanyCodeCard() {
  const t = useT("people");
  const { company, refresh } = useAuth();
  const qc = useQueryClient();
  const companyId = company?.id ?? null;

  const settingsQ = useQuery({
    queryKey: ["company-membership-policy", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("join_code, join_code_enabled, members_can_leave")
        .eq("id", companyId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("regenerate_join_code");
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      toast.success(t("New code made. The old one no longer works."));
      await qc.invalidateQueries({ queryKey: ["company-membership-policy", companyId] });
      await refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const policy = useMutation({
    mutationFn: async (patch: { _join_code_enabled?: boolean; _members_can_leave?: boolean }) => {
      const { error } = await supabase.rpc("set_membership_policy", patch);
      if (error) throw error;
    },
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["company-membership-policy", companyId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const s = settingsQ.data;
  const code = s?.join_code ?? null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold text-foreground">{t("Company code")}</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "Share it with people who should work here. They enter it under Settings → My companies.",
        )}
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest text-foreground sm:text-left">
          {settingsQ.isLoading ? "…" : (code ?? "—")}
        </code>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 sm:flex-none"
            disabled={!code}
            onClick={() => {
              void navigator.clipboard?.writeText(code ?? "");
              toast.success(t("Code copied."));
            }}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            {t("Copy")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 sm:flex-none"
            disabled={regenerate.isPending}
            onClick={() => {
              if (window.confirm(t("Make a new code? The current code stops working right away.")))
                regenerate.mutate();
            }}
          >
            {regenerate.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("New code")}
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-foreground">
              {t("Accept join requests")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("When off, the code is not accepted and nobody can ask to join.")}
            </span>
          </span>
          <Switch
            checked={s?.join_code_enabled ?? true}
            disabled={!s || policy.isPending}
            onCheckedChange={(v) => policy.mutate({ _join_code_enabled: v })}
          />
        </label>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-foreground">
              {t("Members can leave on their own")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("When off, only an admin can remove someone from the company.")}
            </span>
          </span>
          <Switch
            checked={s?.members_can_leave ?? true}
            disabled={!s || policy.isPending}
            onCheckedChange={(v) => policy.mutate({ _members_can_leave: v })}
          />
        </label>
      </div>
    </div>
  );
}
