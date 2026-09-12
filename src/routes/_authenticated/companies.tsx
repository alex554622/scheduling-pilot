import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { CompanyBillingSection } from "@/components/company-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Building2,
  Loader2,
  Search,
  CheckCircle2,
  ChevronRight,
  X,
  Users,
  CreditCard,
  Trash2,
  AlertTriangle,
  KeyRound,
  Clock,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/companies")({
  component: CompaniesPage,
});

interface Company {
  id: string;
  name: string;
  plan: string;
  status: string;
  billing_mode: string;
  join_code: string | null;
  created_at: string;
  /** How many months of schedule and timecard history this company keeps. Null = forever. */
  data_retention_months: number | null;
}

/** What a company may hold, as a platform admin sets it. */
const RETENTION_CHOICES: { label: string; months: number | null }[] = [
  { label: "6 months", months: 6 },
  { label: "1 year", months: 12 },
  { label: "Unlimited", months: null },
];

interface HistoryStats {
  retention_months: number | null;
  cutoff: string | null;
  punches: number;
  shifts: number;
  oldest_punch: string | null;
  oldest_shift: string | null;
  punches_past_window: number;
  shifts_past_window: number;
}
type SubRow = {
  id: string;
  company_id: string;
  status: string;
  plan_id: string | null;
  seats_limit: number | null;
  current_period_end: string | null;
};
type PlanRow = { id: string; name: string; price_cents: number };

const STATUSES = ["pending", "active", "past_due", "suspended"] as const;
const SUB_STATUSES = ["trialing", "active", "past_due", "inactive", "canceled"] as const;
const BILLING_MODES = [
  { value: "pending", label: "Pending review" },
  { value: "card", label: "Card (Stripe)" },
  { value: "cash", label: "Cash / invoice" },
  { value: "waived", label: "Waived (free)" },
] as const;

const STATUS_CLS: Record<string, string> = {
  active: "bg-success/15 text-success",
  pending: "bg-warning/20 text-warning-foreground",
  past_due: "bg-warning/20 text-warning-foreground",
  suspended: "bg-destructive/10 text-destructive",
};

function CompaniesPage() {
  const { primaryRole, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "super_admin") navigate({ to: "/dashboard" });
  }, [loading, primaryRole, navigate]);

  const isSuper = primaryRole === "super_admin";

  const companiesQ = useQuery({
    queryKey: ["companies-admin"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select(
          "id, name, plan, status, billing_mode, join_code, created_at, data_retention_months",
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Company[];
    },
  });

  // Headcount per company in one pass rather than a count query per row.
  const headcountQ = useQuery({
    queryKey: ["companies-headcount"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("company_id");
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const r of data ?? [])
        if (r.company_id) map[r.company_id] = (map[r.company_id] ?? 0) + 1;
      return map;
    },
  });

  const subsQ = useQuery({
    queryKey: ["companies-subs"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_subscriptions")
        .select("id, company_id, status, plan_id, seats_limit, current_period_end");
      if (error) throw error;
      return (data ?? []) as SubRow[];
    },
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Company> }) => {
      const { error } = await supabase.from("companies").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies-admin"] });
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  if (loading || !isSuper) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const all = companiesQ.data ?? [];
  const heads = headcountQ.data ?? {};
  const subs = subsQ.data ?? [];

  const companies = all
    .filter((c) => filter === "all" || c.status === filter)
    .filter((c) => !search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase()));

  const pending = all.filter((c) => c.status === "pending");
  const current = selected ? (all.find((c) => c.id === selected) ?? null) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Companies</h1>
        <p className="text-sm text-muted-foreground">
          Every tenant on the platform. Approve, suspend, adjust billing, or close an account.
        </p>
      </div>

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      {pending.length > 0 && (
        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <p className="mb-3 text-sm font-medium text-warning-foreground">
            {pending.length} company{pending.length === 1 ? "" : "ies"} awaiting approval
          </p>
          <ul className="space-y-2">
            {pending.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Requested {new Date(c.created_at).toLocaleDateString()} · {heads[c.id] ?? 0}{" "}
                    member{(heads[c.id] ?? 0) === 1 ? "" : "s"}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={updateMut.isPending}
                  onClick={() => updateMut.mutate({ id: c.id, patch: { status: "active" } })}
                >
                  <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                  Approve
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Approving activates the account and generates its join code so employees can request
            access.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search companies…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {(["all", ...STATUSES] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
              filter === s
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            {companies.length} of {all.length} compan{all.length === 1 ? "y" : "ies"}
          </h2>
        </div>
        {companiesQ.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : companies.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No companies match.</p>
        ) : (
          <ul className="divide-y divide-border">
            {companies.map((c) => {
              const sub = subs.find((s) => s.company_id === c.id);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c.id)}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {c.name}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLS[c.status] ?? "bg-secondary text-muted-foreground"}`}
                        >
                          {c.status.replace("_", " ")}
                        </span>
                        {sub && (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            sub: {sub.status}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {heads[c.id] ?? 0} member{(heads[c.id] ?? 0) === 1 ? "" : "s"}
                        {" · "}
                        {c.plan}
                        {" · "}joined {new Date(c.created_at).toLocaleDateString()}
                        {c.join_code && (
                          <>
                            {" "}
                            · code <span className="font-mono">{c.join_code}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {current && (
        <CompanyDetail
          company={current}
          headcount={heads[current.id] ?? 0}
          subscription={subs.find((s) => s.company_id === current.id) ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ company detail ----------------------------- */

function CompanyDetail({
  company,
  headcount,
  subscription,
  onClose,
}: {
  company: Company;
  headcount: number;
  subscription: SubRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["companies-admin"] });
    qc.invalidateQueries({ queryKey: ["companies-subs"] });
    qc.invalidateQueries({ queryKey: ["companies-headcount"] });
    qc.invalidateQueries({ queryKey: ["platform-companies"] });
    qc.invalidateQueries({ queryKey: ["platform-subs"] });
  };

  const membersQ = useQuery({
    queryKey: ["company-members-admin", company.id],
    queryFn: async () => {
      const [{ data: profiles, error: pErr }, { data: roles, error: rErr }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, is_active")
          .eq("company_id", company.id)
          .order("full_name"),
        supabase.from("user_roles").select("user_id, role").eq("company_id", company.id),
      ]);
      if (pErr) throw pErr;
      if (rErr) throw rErr;
      const roleBy: Record<string, AppRole[]> = {};
      for (const r of roles ?? []) (roleBy[r.user_id] ??= []).push(r.role as AppRole);
      return (profiles ?? []).map((p) => ({ ...p, roles: roleBy[p.id] ?? [] }));
    },
  });

  // The billing admin's email lives in auth.users, which no client can read.
  // `billing_overview` already resolves it for super admins, so reuse that
  // rather than adding a second way to look the same thing up.
  const billingQ = useQuery({
    queryKey: ["billing-overview"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("billing_overview");
      if (error) throw error;
      return (data ?? []) as { company_id: string; admin_email: string | null }[];
    },
  });
  const adminEmail = billingQ.data?.find((r) => r.company_id === company.id)?.admin_email ?? null;

  const plansQ = useQuery({
    queryKey: ["platform-plans-lite"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pricing_plans")
        .select("id, name, price_cents")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as PlanRow[];
    },
  });

  // A super admin has no company of their own, so the rename on Settings never
  // reaches them. This is where they can rename any organization on the platform.
  const [nameDraft, setNameDraft] = useState(company.name);
  useEffect(() => setNameDraft(company.name), [company.id, company.name]);

  const updateCompany = useMutation({
    mutationFn: async (patch: Partial<Company>) => {
      const { error } = await supabase.from("companies").update(patch).eq("id", company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  // Upsert so a company with no subscription row gets one on first change.
  const saveSub = useMutation({
    mutationFn: async (patch: {
      status?: string;
      plan_id?: string | null;
      seats_limit?: number | null;
    }) => {
      if (subscription) {
        const { error } = await supabase
          .from("company_subscriptions")
          .update(patch)
          .eq("id", subscription.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("company_subscriptions").insert({
          company_id: company.id,
          status: patch.status ?? "trialing",
          plan_id: patch.plan_id ?? null,
          seats_limit: patch.seats_limit ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      invalidate();
      setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const deleteCompany = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("companies").delete().eq("id", company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setConfirmDelete(false);
      onClose();
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const members = membersQ.data ?? [];
  const plans = plansQ.data ?? [];

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{company.name}</h2>
          <p className="text-xs text-muted-foreground">
            {headcount} member{headcount === 1 ? "" : "s"} · created{" "}
            {new Date(company.created_at).toLocaleDateString()}
            {company.join_code && (
              <>
                {" "}
                · join code <span className="font-mono text-foreground">{company.join_code}</span>
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close detail">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-2">
        <div className="space-y-4">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-primary" />
            Account
          </h3>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="org-name">
              Organization name
            </Label>
            <div className="flex gap-2">
              <Input
                id="org-name"
                value={nameDraft}
                maxLength={120}
                placeholder="e.g. City of Calexico"
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameDraft.trim() && nameDraft.trim() !== company.name) {
                    updateCompany.mutate({ name: nameDraft.trim() });
                  }
                }}
              />
              <Button
                size="sm"
                disabled={
                  updateCompany.isPending || !nameDraft.trim() || nameDraft.trim() === company.name
                }
                onClick={() => updateCompany.mutate({ name: nameDraft.trim() })}
              >
                {updateCompany.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Shown to everyone in this organization and on anything they print.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Account status</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm capitalize shadow-sm"
              value={company.status}
              disabled={updateCompany.isPending}
              onChange={(e) => updateCompany.mutate({ status: e.target.value })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Anything other than active blocks sign-in for this tenant and notifies its members.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Billing mode</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
              value={company.billing_mode ?? "pending"}
              disabled={updateCompany.isPending}
              onChange={(e) => updateCompany.mutate({ billing_mode: e.target.value })}
            >
              {BILLING_MODES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>

          <h3 className="flex items-center gap-2 pt-2 text-sm font-medium text-foreground">
            <CreditCard className="h-4 w-4 text-primary" />
            Subscription
          </h3>
          {!subscription && (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              No subscription record — treated as a trial, so scheduling still works. Setting
              anything below creates one.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm capitalize shadow-sm"
                value={subscription?.status ?? "trialing"}
                disabled={saveSub.isPending}
                onChange={(e) => saveSub.mutate({ status: e.target.value })}
              >
                {SUB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Plan</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                value={subscription?.plan_id ?? ""}
                disabled={saveSub.isPending}
                onChange={(e) => saveSub.mutate({ plan_id: e.target.value || null })}
              >
                <option value="">— none —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (${(p.price_cents / 100).toFixed(0)})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Setting the subscription to inactive or canceled stops new schedules being created;
            existing ones stay visible to employees.
          </p>

          <CompanyBillingSection
            target={{
              companyId: company.id,
              companyName: company.name,
              companyStatus: company.status,
              subStatus: subscription?.status ?? "none",
              planName: plans.find((p) => p.id === subscription?.plan_id)?.name ?? "—",
              amountCents: plans.find((p) => p.id === subscription?.plan_id)?.price_cents ?? 0,
              periodEnd: subscription?.current_period_end ?? null,
              adminEmail: adminEmail ?? null,
            }}
          />

          <RetentionCard
            company={company}
            onChange={(months) => updateCompany.mutate({ data_retention_months: months })}
          />

          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Danger zone
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deleting removes the company and everything scoped to it — schedules, shifts, punches,
              time off, and role assignments. Sign-in accounts survive but are left with no company.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setErr(null);
                setConfirmDelete(true);
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete company
            </Button>
          </div>

          {err && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
          )}
        </div>

        <div className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 text-primary" />
            Members ({members.length})
          </h3>
          {membersQ.isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nobody has joined yet.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{m.full_name || "Unnamed"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.roles.length ? m.roles.map((r) => ROLE_LABEL[r]).join(", ") : "No role"}
                    </p>
                  </div>
                  {!m.is_active && (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                      inactive
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <DeleteCompanyDialog
        open={confirmDelete}
        companyName={company.name}
        pending={deleteCompany.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => deleteCompany.mutate()}
      />
    </div>
  );
}

/**
 * How long this company keeps schedule and timecard history, and what it is
 * holding right now. Nothing expires on a timer — a platform admin sets the
 * window, sees what sits beyond it, and clears it deliberately.
 */
function RetentionCard({
  company,
  onChange,
}: {
  company: Company;
  onChange: (months: number | null) => void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const statsQ = useQuery({
    queryKey: ["company-history-stats", company.id, company.data_retention_months],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("company_history_stats", { _company: company.id });
      if (error) throw error;
      return data as unknown as HistoryStats;
    },
  });

  const purge = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("purge_company_history", { _company: company.id });
      if (error) throw error;
      return data as unknown as { punches_deleted: number; shifts_deleted: number };
    },
    onSuccess: (r) => {
      setDone(`Deleted ${r.punches_deleted} punches and ${r.shifts_deleted} shifts.`);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["company-history-stats"] });
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const s = statsQ.data;
  const beyond = (s?.punches_past_window ?? 0) + (s?.shifts_past_window ?? 0);
  const since = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—";

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Clock className="h-4 w-4 text-primary" /> History kept
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        How far back this company's admins can see schedules and timecards.
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {RETENTION_CHOICES.map((c) => {
          const active = (company.data_retention_months ?? null) === c.months;
          return (
            <button
              key={c.label}
              type="button"
              onClick={() => onChange(c.months)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                active
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Punches</dt>
          <dd className="font-medium text-foreground">{s?.punches ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Shifts</dt>
          <dd className="font-medium text-foreground">{s?.shifts ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oldest punch</dt>
          <dd className="font-medium text-foreground">{since(s?.oldest_punch)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oldest shift</dt>
          <dd className="font-medium text-foreground">{since(s?.oldest_shift)}</dd>
        </div>
      </dl>

      {done && <p className="mt-2 text-xs font-medium text-primary">{done}</p>}
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}

      {company.data_retention_months !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            {beyond > 0
              ? `${s?.punches_past_window ?? 0} punches and ${s?.shifts_past_window ?? 0} shifts are older than ${company.data_retention_months} months.`
              : "Nothing is older than the window."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={beyond === 0}
            onClick={() => {
              setErr(null);
              setDone(null);
              setConfirming(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Delete older than window
          </Button>
        </div>
      )}

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {company.name}&rsquo;s older records?</DialogTitle>
              <DialogDescription>
                {s?.punches_past_window ?? 0} punches and {s?.shifts_past_window ?? 0} shifts from
                before {s?.cutoff ? new Date(s.cutoff).toLocaleDateString() : "the window"} are
                removed for good. Timecards that have already been paid rely on these records, so
                check with the company first.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => purge.mutate()}
                disabled={purge.isPending}
              >
                {purge.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Delete them
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function DeleteCompanyDialog({
  open,
  companyName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  companyName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const matches = typed.trim() === companyName;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {companyName}?</DialogTitle>
          <DialogDescription>
            This cannot be undone. Every schedule, shift, timecard, punch, time-off request and role
            assignment belonging to this company is permanently removed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="confirm-name" className="text-xs">
            Type <span className="font-medium text-foreground">{companyName}</span> to confirm
          </Label>
          <Input
            id="confirm-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={!matches || pending}
            onClick={onConfirm}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
