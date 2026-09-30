import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, ROLE_LABEL, type AppRole } from "@/lib/auth";
import { ago, downloadCsv, slug } from "@/lib/admin-export";
import { CompanyBillingSection } from "@/components/company-billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { playBreakAlert } from "@/lib/notify-sound";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Activity,
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  Download,
  Hourglass,
  Inbox,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  Users,
  Volume2,
  XCircle,
} from "lucide-react";

/**
 * The platform admin's console for every business on the platform.
 *
 * Two jobs, in the order they matter. First the queue: a business that has
 * registered is locked out until someone here says yes, so it opens on the
 * decision with everything the decision needs — who registered, how to reach
 * them, who has already joined. Then the directory: every company, searchable
 * by its name or by the person behind it, each opening into a panel that holds
 * all of it — people, billing, settings, and what has happened to it.
 *
 * `?company=<id>` opens that company's panel, which is where the "new business"
 * notification lands.
 */

const searchSchema = z.object({
  company: z.string().uuid().optional().catch(undefined),
  view: z.enum(["queue", "all"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/companies")({
  validateSearch: (s) => searchSchema.parse(s),
  component: CompaniesPage,
});

/** One row of `admin_companies()`. */
interface CompanyRow {
  id: string;
  name: string;
  status: string;
  plan: string;
  billing_mode: string;
  join_code: string | null;
  created_at: string;
  timezone: string;
  /** How many months of schedule and timecard history this company keeps. Null = forever. */
  data_retention_months: number | null;
  business_phone: string | null;
  business_address: string | null;
  created_by: string | null;
  creator_name: string | null;
  creator_email: string | null;
  creator_email_confirmed: boolean;
  creator_phone: string | null;
  creator_last_sign_in_at: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  member_count: number;
  admin_count: number;
  inactive_count: number;
  pending_join_count: number;
  sub_status: string;
  plan_name: string | null;
  period_end: string | null;
  last_punch_at: string | null;
}

/** One row of `admin_accounts()` — where a person's email comes from. */
interface AccountRow {
  user_id: string;
  email: string | null;
  email_confirmed: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  full_name: string;
  company_id: string | null;
  pending_company_id: string | null;
  is_active: boolean;
  roles: string[];
}

/** The profile columns `admin_accounts()` does not carry. */
interface ProfileExtra {
  id: string;
  position: string | null;
  phone: string | null;
  employee_code: string | null;
}

/** A person as the console shows them: the account and the profile, together. */
interface Member {
  id: string;
  full_name: string;
  email: string | null;
  email_confirmed: boolean;
  last_sign_in_at: string | null;
  created_at: string;
  is_active: boolean;
  roles: AppRole[];
  position: string | null;
  phone: string | null;
  employee_code: string | null;
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

/** Statuses a live company moves between. Pending and rejected are decided by review. */
const LIVE_STATUSES = ["active", "past_due", "suspended"] as const;
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
  rejected: "bg-destructive/10 text-destructive",
};

type StatusFilter = "all" | "pending" | "active" | "attention" | "rejected";

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Awaiting approval" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Past due / suspended" },
  { key: "rejected", label: "Rejected" },
];

function matchesFilter(c: CompanyRow, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "attention") return c.status === "past_due" || c.status === "suspended";
  return c.status === f;
}

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "—";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Admins first — whoever registered the company is one — then by name. */
function byRank(a: Member, b: Member): number {
  const rank = (m: Member) => (m.roles.includes("company_admin") ? 0 : 1);
  return rank(a) - rank(b) || a.full_name.localeCompare(b.full_name);
}

/* ================================================================== page == */

function CompaniesPage() {
  const { primaryRole, loading } = useAuth();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<CompanyRow | null>(null);

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "super_admin") navigate({ to: "/dashboard" });
  }, [loading, primaryRole, navigate]);

  const isSuper = primaryRole === "super_admin";

  const directoryQ = useQuery({
    queryKey: ["admin-companies"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_companies");
      if (error) throw error;
      return (data ?? []) as CompanyRow[];
    },
  });

  // Shared with the Accounts page on purpose: one cache, so a change made on
  // either screen is the same change on both.
  const accountsQ = useQuery({
    queryKey: ["admin-accounts"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_accounts");
      if (error) throw error;
      return (data ?? []) as AccountRow[];
    },
  });

  const profilesQ = useQuery({
    queryKey: ["companies-people"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, position, phone, employee_code");
      if (error) throw error;
      return (data ?? []) as ProfileExtra[];
    },
  });

  const invalidate = () => invalidateCompanyViews(qc);

  const review = useMutation({
    mutationFn: async (v: { id: string; approve: boolean; note?: string }) => {
      const { error } = await supabase.rpc("admin_review_company", {
        _company: v.id,
        _approve: v.approve,
        _note: v.note ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      setRejecting(null);
      invalidate();
    },
    onError: (e) => setErr(errText(e)),
  });

  const all = useMemo(() => directoryQ.data ?? [], [directoryQ.data]);

  /** Everyone, filed under the company they are in and the one they asked to join. */
  const people = useMemo(() => {
    const extra = new Map((profilesQ.data ?? []).map((p) => [p.id, p]));
    const members = new Map<string, Member[]>();
    const joins = new Map<string, Member[]>();
    const names = new Map<string, string>();
    let unplaced = 0;
    for (const a of accountsQ.data ?? []) {
      const p = extra.get(a.user_id);
      const m: Member = {
        id: a.user_id,
        full_name: a.full_name || "Unnamed",
        email: a.email,
        email_confirmed: a.email_confirmed,
        last_sign_in_at: a.last_sign_in_at,
        created_at: a.created_at,
        is_active: a.is_active,
        roles: a.roles.filter((r): r is AppRole => r in ROLE_LABEL),
        position: p?.position ?? null,
        phone: p?.phone ?? null,
        employee_code: p?.employee_code ?? null,
      };
      names.set(a.user_id, a.full_name || a.email || "Unknown");
      if (a.company_id) push(members, a.company_id, m);
      if (a.pending_company_id) push(joins, a.pending_company_id, m);
      if (!a.company_id && !a.pending_company_id && !a.roles.includes("super_admin")) unplaced++;
    }
    for (const list of members.values()) list.sort(byRank);
    return { members, joins, names, unplaced };
  }, [accountsQ.data, profilesQ.data]);

  if (loading || !isSuper) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const pending = all.filter((c) => c.status === "pending");
  const counts: Record<StatusFilter, number> = {
    all: all.length,
    pending: pending.length,
    active: all.filter((c) => c.status === "active").length,
    attention: all.filter((c) => matchesFilter(c, "attention")).length,
    rejected: all.filter((c) => c.status === "rejected").length,
  };
  const weekAgo = Date.now() - 7 * 86_400_000;
  const newThisWeek = all.filter((c) => new Date(c.created_at).getTime() > weekAgo).length;

  const q = query.trim().toLowerCase();
  const rows = all
    .filter((c) => matchesFilter(c, filter))
    .filter(
      (c) =>
        !q ||
        [c.name, c.creator_name, c.creator_email, c.join_code, c.business_phone]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(q)),
    );

  const view = search.view ?? (pending.length > 0 ? "queue" : "all");
  const selected = search.company ? (all.find((c) => c.id === search.company) ?? null) : null;

  const open = (id: string) => navigate({ search: (s) => ({ ...s, company: id }) });
  const close = () => navigate({ search: (s) => ({ ...s, company: undefined }) });
  const showAll = (f: StatusFilter) => {
    setFilter(f);
    navigate({ search: (s) => ({ ...s, view: "all" }) });
  };

  const exportDirectory = () =>
    downloadCsv(
      `companies-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Company",
        "Status",
        "Registered",
        "Registered by",
        "Registered by email",
        "Registered by phone",
        "Business phone",
        "Business address",
        "Members",
        "Admins",
        "Join requests",
        "Subscription",
        "Plan",
        "Period ends",
        "Join code",
        "Last clock-in",
        "Reviewed by",
        "Reviewed at",
        "Review note",
      ],
      rows.map((c) => [
        c.name,
        c.status,
        c.created_at,
        c.creator_name,
        c.creator_email,
        c.creator_phone,
        c.business_phone,
        c.business_address,
        c.member_count,
        c.admin_count,
        c.pending_join_count,
        c.sub_status,
        c.plan_name,
        c.period_end,
        c.join_code,
        c.last_punch_at,
        c.reviewed_by_name,
        c.reviewed_at,
        c.review_note,
      ]),
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Companies</h1>
          <p className="text-sm text-muted-foreground">
            Every business on the platform — approve new ones, and look up anyone behind any of
            them.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportDirectory} disabled={!rows.length}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          icon={Hourglass}
          label="Awaiting approval"
          value={counts.pending}
          tone={counts.pending ? "warning" : "muted"}
          onClick={() => navigate({ search: (s) => ({ ...s, view: "queue" }) })}
        />
        <Stat
          icon={CheckCircle2}
          label="Active"
          value={counts.active}
          tone="success"
          onClick={() => showAll("active")}
        />
        <Stat
          icon={AlertTriangle}
          label="Past due / suspended"
          value={counts.attention}
          tone={counts.attention ? "danger" : "muted"}
          onClick={() => showAll("attention")}
        />
        <Stat
          icon={XCircle}
          label="Rejected"
          value={counts.rejected}
          tone="muted"
          onClick={() => showAll("rejected")}
        />
        <Stat
          icon={Building2}
          label="New this week"
          value={newThisWeek}
          tone="primary"
          onClick={() => showAll("all")}
        />
      </div>

      {people.unplaced > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {plural(people.unplaced, "signed-up account")}
            </span>{" "}
            {people.unplaced === 1 ? "belongs" : "belong"} to no company yet.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/accounts">Review in Accounts</Link>
          </Button>
        </div>
      )}

      {directoryQ.error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
          <p className="font-medium text-destructive">{errText(directoryQ.error)}</p>
          <p className="mt-1 text-muted-foreground">
            If this says <span className="font-mono">admin_companies</span> is missing, apply{" "}
            <span className="font-mono">20260930150000_company_review_and_directory.sql</span> to
            this database.
          </p>
        </div>
      ) : (
        <Tabs
          value={view}
          onValueChange={(v) => navigate({ search: (s) => ({ ...s, view: v as "queue" | "all" }) })}
        >
          <TabsList>
            <TabsTrigger value="queue" className="gap-2">
              <Inbox className="h-4 w-4" />
              Approval queue
              {pending.length > 0 && (
                <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-warning-foreground">
                  {pending.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="all" className="gap-2">
              <Building2 className="h-4 w-4" />
              All companies
            </TabsTrigger>
          </TabsList>

          <TabsContent value="queue" className="mt-4 space-y-3">
            {directoryQ.isLoading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : pending.length === 0 ? (
              <div className="rounded-2xl border border-border bg-card px-5 py-12 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
                <p className="mt-2 text-sm font-medium text-foreground">Nothing waiting</p>
                <p className="text-xs text-muted-foreground">
                  New registrations land here, and you get a notification the moment one does.
                </p>
              </div>
            ) : (
              pending.map((c) => (
                <ReviewCard
                  key={c.id}
                  company={c}
                  members={people.members.get(c.id) ?? []}
                  busy={review.isPending}
                  onOpen={() => open(c.id)}
                  onApprove={() => review.mutate({ id: c.id, approve: true })}
                  onReject={() => {
                    setErr(null);
                    setRejecting(c);
                  }}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="all" className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
              <div className="relative min-w-48 flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 pl-8"
                  placeholder="Company, owner name or email, join code…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    filter === f.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f.label} ({counts[f.key]})
                </button>
              ))}
            </div>

            <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex items-center gap-2 border-b border-border px-5 py-3">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  {rows.length} of {plural(all.length, "company", "companies")}
                </h2>
              </div>
              {directoryQ.isLoading ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No companies match.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((c) => (
                    <li key={c.id}>
                      <CompanyListRow company={c} onOpen={() => open(c.id)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && close()}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-2xl">
          {selected && (
            <CompanyPanel
              key={selected.id}
              company={selected}
              members={people.members.get(selected.id) ?? []}
              joins={people.joins.get(selected.id) ?? []}
              nameOf={(id) => people.names.get(id) ?? null}
              reviewing={review.isPending}
              onApprove={() => review.mutate({ id: selected.id, approve: true })}
              onReject={() => {
                setErr(null);
                setRejecting(selected);
              }}
              onDeleted={close}
            />
          )}
        </SheetContent>
      </Sheet>

      <RejectDialog
        company={rejecting}
        pending={review.isPending}
        error={rejecting ? err : null}
        onCancel={() => setRejecting(null)}
        onConfirm={(note) => rejecting && review.mutate({ id: rejecting.id, approve: false, note })}
      />
    </div>
  );
}

/** Everything that shows a company or counts its people is stale after any change here. */
function invalidateCompanyViews(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    "admin-companies",
    "admin-accounts",
    "companies-people",
    "companies-subs",
    "company-subscription",
    "company-activity",
    "billing-overview",
    "platform-companies",
    "platform-subs",
    "pending-companies-count",
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  tone: "primary" | "success" | "warning" | "danger" | "muted";
  onClick: () => void;
}) {
  const toneCls = {
    primary: "bg-primary-soft text-primary",
    success: "bg-success/15 text-success",
    warning: "bg-warning/20 text-warning-foreground",
    danger: "bg-destructive/10 text-destructive",
    muted: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent/50"
    >
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${toneCls}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold text-foreground">{value}</p>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_CLS[status] ?? "bg-secondary text-muted-foreground"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function Pill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "success" | "primary";
}) {
  const cls = {
    muted: "bg-secondary text-muted-foreground",
    warning: "bg-warning/20 text-warning-foreground",
    success: "bg-success/15 text-success",
    primary: "bg-primary-soft text-primary",
  }[tone];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-normal ${cls}`}>{children}</span>
  );
}

/** Name, then a mailto — or a plain "unknown" when the account is gone. */
function Creator({ company }: { company: CompanyRow }) {
  if (!company.created_by && !company.creator_email) {
    return <span className="text-muted-foreground">creator unknown</span>;
  }
  return (
    <>
      {company.creator_name ?? company.creator_email}
      {company.creator_name && company.creator_email && (
        <span className="text-muted-foreground"> · {company.creator_email}</span>
      )}
    </>
  );
}

/* ============================================================ the queue == */

/**
 * One registration, with everything the decision needs on the card itself.
 * Sending a platform admin hunting through another page first is how a real
 * business ends up waiting on a rubber stamp.
 */
function ReviewCard({
  company: c,
  members,
  busy,
  onOpen,
  onApprove,
  onReject,
}: {
  company: CompanyRow;
  members: Member[];
  busy: boolean;
  onOpen: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-2xl border border-warning/40 bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">
            {c.name}
            <StatusBadge status={c.status} />
          </p>
          <p className="text-xs text-muted-foreground">
            Registered {fmtDateTime(c.created_at)} ({ago(c.created_at)})
            {c.plan_name && <> · trial of {c.plan_name}</>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Details
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onReject}
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Ban className="mr-2 h-3.5 w-3.5" />
            Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={onApprove}>
            {busy ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
            )}
            Approve
          </Button>
        </div>
      </div>

      <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
        <OwnerBlock company={c} />
        <BusinessBlock company={c} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">
          People attached so far ({members.length})
          {c.pending_join_count > 0 && <> · {plural(c.pending_join_count, "join request")}</>}
        </p>
        <PeopleList people={members} empty="Nobody is attached to this company yet." compact />
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Approving unlocks the workspace, starts the free trial and issues a join code. The owner is
        notified either way.
      </p>
    </div>
  );
}

function OwnerBlock({ company: c }: { company: CompanyRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Registered by
      </p>
      {c.creator_email || c.creator_name ? (
        <>
          <p className="truncate text-sm font-medium text-foreground">
            {c.creator_name ?? "No name given"}
          </p>
          {c.creator_email && (
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a
                href={`mailto:${c.creator_email}`}
                className="truncate text-primary hover:underline"
              >
                {c.creator_email}
              </a>
              {c.creator_email_confirmed ? (
                <Pill tone="success">confirmed</Pill>
              ) : (
                <Pill tone="warning">unconfirmed</Pill>
              )}
            </p>
          )}
          {c.creator_phone && (
            <p className="flex items-center gap-1.5 text-sm">
              <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a href={`tel:${c.creator_phone}`} className="text-foreground hover:underline">
                {c.creator_phone}
              </a>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Last sign-in {ago(c.creator_last_sign_in_at)}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Not recorded — the account that registered it has been deleted.
        </p>
      )}
    </div>
  );
}

function BusinessBlock({ company: c }: { company: CompanyRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Business</p>
      {c.business_phone ? (
        <p className="flex items-center gap-1.5 text-sm">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <a href={`tel:${c.business_phone}`} className="text-foreground hover:underline">
            {c.business_phone}
          </a>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No business phone given</p>
      )}
      {c.business_address ? (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="whitespace-pre-line">{c.business_address}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No address given</p>
      )}
      <p className="text-xs text-muted-foreground">Time zone {c.timezone}</p>
    </div>
  );
}

/* ======================================================== the directory == */

function CompanyListRow({ company: c, onOpen }: { company: CompanyRow; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-accent/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
          <StatusBadge status={c.status} />
          {c.sub_status !== "none" && <Pill>sub: {c.sub_status}</Pill>}
          {c.pending_join_count > 0 && (
            <Pill tone="warning">{plural(c.pending_join_count, "join request")}</Pill>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-foreground/80">
          <Creator company={c} />
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {plural(c.member_count, "member")}
          {c.plan_name && <> · {c.plan_name}</>}
          {" · "}registered {fmtDate(c.created_at)}
          {" · "}last clock-in {ago(c.last_punch_at)}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/* ============================================================ the panel == */

function CompanyPanel({
  company,
  members,
  joins,
  nameOf,
  reviewing,
  onApprove,
  onReject,
  onDeleted,
}: {
  company: CompanyRow;
  members: Member[];
  joins: Member[];
  nameOf: (userId: string) => string | null;
  reviewing: boolean;
  onApprove: () => void;
  onReject: () => void;
  onDeleted: () => void;
}) {
  const undecided = company.status === "pending" || company.status === "rejected";
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <SheetHeader className="space-y-1 border-b border-border px-5 py-4 pr-12 text-left">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {company.name}
          <StatusBadge status={company.status} />
        </SheetTitle>
        <SheetDescription className="text-xs">
          {plural(company.member_count, "member")} · registered {fmtDate(company.created_at)}
          {company.join_code && (
            <>
              {" · "}join code{" "}
              <button
                type="button"
                className="inline-flex items-center gap-1 font-mono text-foreground hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(company.join_code!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                title="Copy join code"
              >
                {company.join_code}
                <Copy className="h-3 w-3" />
              </button>
              {copied && <span className="ml-1 text-success">copied</span>}
            </>
          )}
        </SheetDescription>
        {undecided && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" disabled={reviewing} onClick={onApprove}>
              {reviewing ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
              )}
              {company.status === "rejected" ? "Approve after all" : "Approve"}
            </Button>
            {company.status === "pending" && (
              <Button
                variant="outline"
                size="sm"
                disabled={reviewing}
                onClick={onReject}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Ban className="mr-2 h-3.5 w-3.5" />
                Reject
              </Button>
            )}
          </div>
        )}
      </SheetHeader>

      <Tabs defaultValue="overview" className="flex-1 px-5 py-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="people">
            People ({members.length}
            {joins.length ? ` + ${joins.length}` : ""})
          </TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <OverviewTab company={company} />
        </TabsContent>
        <TabsContent value="people" className="mt-4 space-y-4">
          <PeopleTab company={company} members={members} joins={joins} />
        </TabsContent>
        <TabsContent value="billing" className="mt-4 space-y-4">
          <BillingTab company={company} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4 space-y-4">
          <SettingsTab company={company} onDeleted={onDeleted} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab company={company} nameOf={nameOf} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Building2;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}

function OverviewTab({ company: c }: { company: CompanyRow }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Owner" icon={KeyRound}>
          <OwnerBlock company={c} />
        </Section>
        <Section title="Contact" icon={Building2}>
          <BusinessBlock company={c} />
        </Section>
      </div>

      <Section title="At a glance" icon={Activity}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label="Members">{c.member_count}</Fact>
          <Fact label="Admins">{c.admin_count}</Fact>
          <Fact label="Inactive">{c.inactive_count}</Fact>
          <Fact label="Join requests">{c.pending_join_count}</Fact>
          <Fact label="Last clock-in">{ago(c.last_punch_at)}</Fact>
          <Fact label="Subscription">
            <span className="capitalize">{c.sub_status}</span>
            {c.plan_name && <> · {c.plan_name}</>}
          </Fact>
          <Fact label="Period ends">{fmtDate(c.period_end)}</Fact>
          <Fact label="Billing mode">
            {BILLING_MODES.find((b) => b.value === c.billing_mode)?.label ?? c.billing_mode}
          </Fact>
          <Fact label="History kept">
            {c.data_retention_months ? `${c.data_retention_months} months` : "Unlimited"}
          </Fact>
        </dl>
      </Section>

      <Section title="Review" icon={ShieldCheck}>
        {c.reviewed_at ? (
          <div className="space-y-1 text-sm">
            <p className="text-foreground">
              {c.status === "rejected" ? "Rejected" : "Approved"} by{" "}
              <span className="font-medium">{c.reviewed_by_name ?? "a deleted account"}</span> on{" "}
              {fmtDateTime(c.reviewed_at)}.
            </p>
            {c.review_note && (
              <p className="rounded-md bg-muted/40 px-3 py-2 text-muted-foreground">
                “{c.review_note}”
              </p>
            )}
          </div>
        ) : c.status === "pending" ? (
          <p className="text-sm text-muted-foreground">
            Waiting for a decision since {fmtDateTime(c.created_at)}.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Reviewed before decisions were recorded.</p>
        )}
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------- people -- */

function PeopleTab({
  company,
  members,
  joins,
}: {
  company: CompanyRow;
  members: Member[];
  joins: Member[];
}) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const approveJoin = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.rpc("approve_membership", { _user: userId });
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      invalidateCompanyViews(qc);
    },
    onError: (e) => setErr(errText(e)),
  });

  const exportMembers = () =>
    downloadCsv(
      `${slug(company.name)}-people.csv`,
      [
        "Name",
        "Email",
        "Email confirmed",
        "Role",
        "Position",
        "Employee code",
        "Phone",
        "Active",
        "Signed up",
        "Last sign-in",
        "Status",
      ],
      [
        ...members.map((m) => [m, "member"] as const),
        ...joins.map((m) => [m, "join request"] as const),
      ].map(([m, kind]) => [
        m.full_name,
        m.email,
        m.email_confirmed ? "yes" : "no",
        m.roles.map((r) => ROLE_LABEL[r]).join(", "),
        m.position,
        m.employee_code,
        m.phone,
        m.is_active ? "yes" : "no",
        m.created_at,
        m.last_sign_in_at,
        kind,
      ]),
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {plural(members.length, "member")}, {company.admin_count} admin
          {company.admin_count === 1 ? "" : "s"}
          {company.inactive_count > 0 && <>, {company.inactive_count} inactive</>}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/accounts">Manage roles</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportMembers}
            disabled={!members.length && !joins.length}
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      {joins.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm font-medium text-warning-foreground">
            {plural(joins.length, "person", "people")} asking to join
          </p>
          <PeopleList
            people={joins}
            empty=""
            action={(m) => (
              <Button
                size="sm"
                variant="outline"
                disabled={approveJoin.isPending || company.status !== "active"}
                title={company.status !== "active" ? "Approve the company first" : ""}
                onClick={() => approveJoin.mutate(m.id)}
              >
                <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                Let in
              </Button>
            )}
          />
        </div>
      )}

      <PeopleList people={members} empty="Nobody has joined yet." />
    </>
  );
}

/**
 * Every person in a company, with the email they sign in with.
 *
 * The email is per person, from `admin_accounts()` — not the one billing
 * address per company that `billing_overview` resolves, which is why this list
 * used to leave it out.
 */
function PeopleList({
  people,
  empty,
  compact = false,
  action,
}: {
  people: Member[];
  empty: string;
  compact?: boolean;
  action?: (m: Member) => ReactNode;
}) {
  if (people.length === 0) {
    return empty ? <p className="mt-2 text-xs text-muted-foreground">{empty}</p> : null;
  }
  return (
    <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {people.map((p) => (
        <li
          key={p.id}
          className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
              <span className="truncate">{p.full_name}</span>
              {p.roles.includes("company_admin") && <Pill tone="primary">admin</Pill>}
              {!p.is_active && <Pill>inactive</Pill>}
              {!p.email_confirmed && <Pill tone="warning">email unconfirmed</Pill>}
            </p>
            {p.email && (
              <a
                href={`mailto:${p.email}`}
                className="block truncate text-xs text-primary hover:underline"
              >
                {p.email}
              </a>
            )}
            {!compact && (
              <p className="truncate text-xs text-muted-foreground">
                {p.roles.length ? p.roles.map((r) => ROLE_LABEL[r]).join(", ") : "No role"}
                {p.position && <> · {p.position}</>}
                {p.employee_code && <> · #{p.employee_code}</>}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-left sm:text-right">
              {p.phone && (
                <a
                  href={`tel:${p.phone}`}
                  className="block text-xs text-foreground hover:underline"
                >
                  {p.phone}
                </a>
              )}
              <p className="text-[11px] text-muted-foreground">
                {compact
                  ? `signed up ${fmtDate(p.created_at)}`
                  : `last sign-in ${ago(p.last_sign_in_at)}`}
              </p>
            </div>
            {action?.(p)}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- billing -- */

function BillingTab({ company }: { company: CompanyRow }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const subQ = useQuery({
    queryKey: ["company-subscription", company.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_subscriptions")
        .select("id, company_id, status, plan_id, seats_limit, current_period_end")
        .eq("company_id", company.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as SubRow | null;
    },
  });

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

  const subscription = subQ.data ?? null;
  const plans = plansQ.data ?? [];

  // Upsert so a company with no subscription row gets one on first change.
  const saveSub = useMutation({
    mutationFn: async (patch: { status?: string; plan_id?: string | null }) => {
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
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setErr(null);
      invalidateCompanyViews(qc);
    },
    onError: (e) => setErr(errText(e)),
  });

  const plan = plans.find((p) => p.id === subscription?.plan_id);

  return (
    <>
      <Section title="Subscription" icon={CreditCard}>
        {!subQ.isLoading && !subscription && (
          <p className="mb-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            No subscription record — treated as a trial, so scheduling still works. Setting anything
            below creates one.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Status</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm capitalize shadow-sm"
              value={subscription?.status ?? "trialing"}
              disabled={saveSub.isPending || subQ.isLoading}
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
              disabled={saveSub.isPending || subQ.isLoading}
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
        <p className="mt-2 text-xs text-muted-foreground">
          Setting the subscription to inactive or canceled stops new schedules being created;
          existing ones stay visible to employees.
        </p>
        {err && (
          <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </p>
        )}
      </Section>

      <CompanyBillingSection
        target={{
          companyId: company.id,
          companyName: company.name,
          companyStatus: company.status,
          subStatus: subscription?.status ?? "none",
          planName: plan?.name ?? "—",
          amountCents: plan?.price_cents ?? 0,
          periodEnd: subscription?.current_period_end ?? null,
          adminEmail: company.creator_email,
        }}
      />
    </>
  );
}

/* -------------------------------------------------------------- settings -- */

function SettingsTab({ company, onDeleted }: { company: CompanyRow; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A super admin has no company of their own, so the rename on Settings never
  // reaches them. This is where they can rename any organization on the platform.
  const [nameDraft, setNameDraft] = useState(company.name);
  useEffect(() => setNameDraft(company.name), [company.id, company.name]);

  // Read on its own, and tolerant of a database that has not taken the
  // migration yet: folding it into the directory would take the whole page
  // down rather than grey out one switch.
  const breakAlertQ = useQuery({
    queryKey: ["company-break-alert-sound", company.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("break_alert_sound")
        .eq("id", company.id)
        .maybeSingle();
      if (error) return { value: false, unavailable: true };
      const row = data as { break_alert_sound?: boolean } | null;
      return { value: row?.break_alert_sound === true, unavailable: false };
    },
  });

  const setBreakAlert = useMutation({
    mutationFn: async (on: boolean) => {
      const { error } = await supabase
        .from("companies")
        .update({ break_alert_sound: on } as never)
        .eq("id", company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["company-break-alert-sound", company.id] });
    },
    onError: (e) => setErr(errText(e)),
  });

  const updateCompany = useMutation({
    mutationFn: async (patch: {
      name?: string;
      status?: string;
      billing_mode?: string;
      data_retention_months?: number | null;
    }) => {
      const { error } = await supabase.from("companies").update(patch).eq("id", company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setErr(null);
      invalidateCompanyViews(qc);
    },
    onError: (e) => setErr(errText(e)),
  });

  const deleteCompany = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("companies").delete().eq("id", company.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateCompanyViews(qc);
      setConfirmDelete(false);
      onDeleted();
    },
    onError: (e) => setErr(errText(e)),
  });

  const undecided = company.status === "pending" || company.status === "rejected";

  return (
    <>
      {err && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>
      )}

      <Section title="Account" icon={KeyRound}>
        <div className="space-y-4">
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
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Account status</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm capitalize shadow-sm"
              value={company.status}
              disabled={updateCompany.isPending || undecided}
              onChange={(e) => updateCompany.mutate({ status: e.target.value })}
            >
              {undecided && <option value={company.status}>{company.status}</option>}
              {LIVE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {undecided
                ? "A registration is decided with Approve or Reject at the top, so the decision is recorded."
                : "Anything other than active blocks sign-in for this company and notifies its members."}
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
        </div>
      </Section>

      {/* Approval, not a company setting: the column carries a trigger that
          refuses this change from anyone but a platform admin. */}
      <section className="space-y-1.5 rounded-xl border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label className="flex items-center gap-1.5 text-sm">
              <Volume2 className="h-4 w-4 text-primary" />
              Break alert sound
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              This company's two-minute break reminder plays a loud recorded alert instead of the
              standard chime, for crews who cannot hear a phone in a pocket.
            </p>
          </div>
          <Switch
            checked={breakAlertQ.data?.value === true}
            disabled={
              breakAlertQ.isLoading || breakAlertQ.data?.unavailable || setBreakAlert.isPending
            }
            onCheckedChange={(v) => setBreakAlert.mutate(v)}
            aria-label="Break alert sound"
          />
        </div>
        {breakAlertQ.data?.unavailable ? (
          <p className="text-xs text-warning-foreground">
            Not available yet — this database is still waiting on the migration that adds it.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => playBreakAlert(true)}
            className="text-xs font-medium text-primary hover:underline"
          >
            Hear it
          </button>
        )}
      </section>

      <RetentionCard
        company={company}
        onChange={(months) => updateCompany.mutate({ data_retention_months: months })}
      />

      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
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

      <DeleteCompanyDialog
        open={confirmDelete}
        companyName={company.name}
        pending={deleteCompany.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => deleteCompany.mutate()}
      />
    </>
  );
}

/* -------------------------------------------------------------- activity -- */

type AuditEntry = {
  id: string;
  action: string;
  entity_type: string;
  actor_id: string | null;
  created_at: string;
};

/** Everything the audit trail holds for this company, newest first. */
function ActivityTab({
  company,
  nameOf,
}: {
  company: CompanyRow;
  nameOf: (userId: string) => string | null;
}) {
  const q = useQuery({
    queryKey: ["company-activity", company.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, action, entity_type, actor_id, created_at")
        .eq("company_id", company.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as AuditEntry[];
    },
  });

  const entries = q.data ?? [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The last 100 recorded changes — approvals, billing, schedules, roles and time off.
      </p>
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{errText(q.error)}</p>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground">{e.action}</p>
                <p className="text-[11px] text-muted-foreground">
                  {e.actor_id ? (nameOf(e.actor_id) ?? "a deleted account") : "the system"}
                </p>
              </div>
              <span
                className="shrink-0 text-[11px] text-muted-foreground"
                title={fmtDateTime(e.created_at)}
              >
                <Clock className="mr-1 inline h-3 w-3" />
                {ago(e.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* =============================================================== dialogs == */

/**
 * Saying no, with a reason. The reason is required because it is the only
 * thing the business is told — "not approved" on its own is a dead end.
 */
function RejectDialog({
  company,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  company: CompanyRow | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [company?.id]);

  return (
    <Dialog open={!!company} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserX className="h-5 w-5 text-destructive" />
            Reject {company?.name}?
          </DialogTitle>
          <DialogDescription>
            {company?.creator_email ? (
              <>
                <span className="font-medium text-foreground">{company.creator_email}</span> and
                anyone attached
              </>
            ) : (
              "Everyone attached"
            )}{" "}
            will be told it was not approved, with the reason below. They stay locked out. You can
            still approve it later from the company's panel.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-note">Reason</Label>
          <Textarea
            id="reject-note"
            rows={3}
            value={note}
            maxLength={500}
            placeholder="e.g. We couldn't verify this business. Reply with your business license and we'll take another look."
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!note.trim() || pending}
            onClick={() => onConfirm(note.trim())}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  company: Pick<CompanyRow, "id" | "name" | "data_retention_months">;
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
    onError: (e: unknown) => setErr(errText(e)),
  });

  const s = statsQ.data;
  const beyond = (s?.punches_past_window ?? 0) + (s?.shifts_past_window ?? 0);
  const since = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
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
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
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
