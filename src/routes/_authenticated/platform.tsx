import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { BillingRenewalsPanel } from "@/components/billing-renewals-panel";
import { CAPABILITY_LABELS, ALL_CAPABILITIES, NO_CAPABILITIES, normalizeCapabilities, planBullets, seatLine, type Capabilities } from "@/lib/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Building2, Users, CreditCard, Activity, Clock, TrendingUp, Loader2,
  Pencil, Plus, Trash2, Star, AlertTriangle, Gift,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/platform")({
  component: PlatformPage,
});

type CompanyRow = { id: string; name: string; status: string; plan: string; created_at: string };
type SubRow = { company_id: string; status: string; plan_id: string | null };
type PlanRow = {
  id: string; name: string; price_cents: number; capacity: string;
  features: unknown; featured: boolean; active: boolean; sort_order: number;
  capabilities: unknown; max_employees: number | null;
};

function PlatformPage() {
  const { primaryRole, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "super_admin") navigate({ to: "/dashboard" });
  }, [loading, primaryRole, navigate]);

  const isSuper = primaryRole === "super_admin";

  const companiesQ = useQuery({
    queryKey: ["platform-companies"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies").select("id, name, status, plan, created_at");
      if (error) throw error;
      return (data ?? []) as CompanyRow[];
    },
  });

  const subsQ = useQuery({
    queryKey: ["platform-subs"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_subscriptions").select("company_id, status, plan_id");
      if (error) throw error;
      return (data ?? []) as SubRow[];
    },
  });

  const plansQ = useQuery({
    queryKey: ["platform-plans"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pricing_plans")
        .select("id, name, price_cents, capacity, features, featured, active, sort_order, capabilities, max_employees")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as PlanRow[];
    },
  });

  const peopleQ = useQuery({
    queryKey: ["platform-people"],
    enabled: isSuper,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("profiles").select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  const activityQ = useQuery({
    queryKey: ["platform-activity"],
    enabled: isSuper,
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [shifts, punches] = await Promise.all([
        supabase.from("shifts").select("id", { count: "exact", head: true }).gte("starts_at", weekAgo),
        supabase.from("time_punches").select("id", { count: "exact", head: true }).gte("at", weekAgo),
      ]);
      if (shifts.error) throw shifts.error;
      if (punches.error) throw punches.error;
      return { shifts: shifts.count ?? 0, punches: punches.count ?? 0 };
    },
  });

  if (loading || !isSuper) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const companies = companiesQ.data ?? [];
  const subs = subsQ.data ?? [];
  const plans = plansQ.data ?? [];
  const planPrice = new Map(plans.map((p) => [p.id, p.price_cents]));

  const byStatus = (s: string) => companies.filter((c) => c.status === s).length;
  const billable = subs.filter((s) => s.status === "active" || s.status === "past_due");
  // Only subscriptions pointing at a real plan contribute revenue.
  const mrrCents = billable.reduce((sum, s) => sum + (s.plan_id ? (planPrice.get(s.plan_id) ?? 0) : 0), 0);
  const unbilled = companies.filter((c) => !subs.some((s) => s.company_id === c.id)).length;
  const newThisWeek = companies.filter((c) => Date.now() - new Date(c.created_at).getTime() < 7 * 86_400_000).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Platform</h1>
        <p className="text-sm text-muted-foreground">
          Analytics and subscription plans across every company on Scheduling Pilot.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Building2} label="Companies" value={String(companies.length)}
          sub={`${byStatus("active")} active · ${byStatus("pending")} pending`} />
        <Metric icon={Users} label="People" value={peopleQ.isLoading ? "…" : String(peopleQ.data ?? 0)}
          sub="profiles across all tenants" tone="muted" />
        <Metric icon={TrendingUp} label="Est. MRR" value={`$${(mrrCents / 100).toLocaleString()}`}
          sub={`${billable.length} billable subscription${billable.length === 1 ? "" : "s"}`} tone="success" />
        <Metric icon={AlertTriangle} label="Needs attention"
          value={String(byStatus("pending") + byStatus("past_due") + byStatus("suspended"))}
          sub={`${byStatus("pending")} awaiting approval`} tone="warning" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Activity} label="Shifts this week"
          value={activityQ.isLoading ? "…" : String(activityQ.data?.shifts ?? 0)} tone="muted" />
        <Metric icon={Clock} label="Punches this week"
          value={activityQ.isLoading ? "…" : String(activityQ.data?.punches ?? 0)} tone="muted" />
        <Metric icon={Building2} label="New this week" value={String(newThisWeek)} tone="muted" />
        <Metric icon={CreditCard} label="No subscription yet" value={String(unbilled)}
          sub="treated as trial" tone="muted" />
      </div>

      {byStatus("pending") > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/15 p-4">
          <p className="text-sm text-warning-foreground">
            <span className="font-medium">{byStatus("pending")} company{byStatus("pending") === 1 ? "" : "ies"}</span>{" "}
            waiting for approval — until approved, nobody there can sign in.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/companies">Review companies</Link>
          </Button>
        </div>
      )}

      <PlansPanel plans={plans} isLoading={plansQ.isLoading} />

      <BillingRenewalsPanel />

      <TrialSettingsPanel plans={plans} />

      <GlobalSettingsPanel />
    </div>
  );
}

function Metric({
  icon: Icon, label, value, sub, tone = "primary",
}: {
  icon: typeof Building2; label: string; value: string; sub?: string;
  tone?: "primary" | "success" | "warning" | "muted";
}) {
  const toneCls = {
    primary: "bg-primary-soft text-primary",
    success: "bg-success/15 text-success",
    warning: "bg-warning/20 text-warning-foreground",
    muted: "bg-secondary text-muted-foreground",
  }[tone];
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${toneCls}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-xl font-semibold text-foreground">{value}</p>
        </div>
      </div>
      {sub && <p className="mt-2 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/* ------------------------------ pricing plans ------------------------------ */

function PlansPanel({ plans, isLoading }: { plans: PlanRow[]; isLoading: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["platform-plans"] });
    qc.invalidateQueries({ queryKey: ["pricing-plans-billing"] });
  };

  const save = useMutation({
    mutationFn: async (v: {
      id?: string; name: string; price_cents: number; capacity: string;
      features: string[]; active: boolean; sort_order: number;
      capabilities: Capabilities; max_employees: number | null;
    }) => {
      const payload = {
        name: v.name, price_cents: v.price_cents, capacity: v.capacity,
        features: v.features, active: v.active, sort_order: v.sort_order,
        capabilities: v.capabilities, max_employees: v.max_employees,
        updated_at: new Date().toISOString(),
      };
      if (v.id) {
        const { error } = await supabase.from("pricing_plans").update(payload).eq("id", v.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("pricing_plans").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { invalidate(); setEditing(null); setCreating(false); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  // Exactly one plan can be featured, so clear the others in the same action.
  const feature = useMutation({
    mutationFn: async (id: string) => {
      const { error: clearErr } = await supabase.from("pricing_plans").update({ featured: false }).neq("id", id);
      if (clearErr) throw clearErr;
      const { error } = await supabase.from("pricing_plans").update({ featured: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("pricing_plans").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Subscription plans</h2>
          <p className="text-xs text-muted-foreground">Shown on the public pricing page and used to compute MRR.</p>
        </div>
        <Button size="sm" onClick={() => { setErr(null); setCreating(true); }}>
          <Plus className="mr-2 h-4 w-4" />Add plan
        </Button>
      </div>

      <div className="p-5">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : plans.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No plans defined.</p>
        ) : (
          <ul className="divide-y divide-border">
            {plans.map((p) => {
              const features = Array.isArray(p.features) ? (p.features as string[]) : [];
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      {p.featured && (
                        <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">Popular</span>
                      )}
                      {!p.active && (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Hidden</span>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      ${(p.price_cents / 100).toFixed(0)}/mo · {p.capacity} · {features.length} feature{features.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!p.featured && (
                      <Button variant="ghost" size="sm" title="Mark as the popular plan"
                        disabled={feature.isPending} onClick={() => feature.mutate(p.id)}>
                        <Star className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => { setErr(null); setEditing(p); }} aria-label={`Edit ${p.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={del.isPending} onClick={() => del.mutate(p.id)} aria-label={`Delete ${p.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </div>

      <PlanDialog
        open={creating || !!editing}
        plan={editing}
        nextSort={(plans[plans.length - 1]?.sort_order ?? 0) + 1}
        pending={save.isPending}
        onCancel={() => { setCreating(false); setEditing(null); }}
        onSave={(v) => save.mutate({ id: editing?.id, ...v })}
      />
    </div>
  );
}

function PlanDialog({
  open, plan, nextSort, pending, onCancel, onSave,
}: {
  open: boolean; plan: PlanRow | null; nextSort: number; pending: boolean;
  onCancel: () => void;
  onSave: (v: { name: string; price_cents: number; capacity: string; features: string[]; active: boolean; sort_order: number; capabilities: Capabilities; max_employees: number | null }) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [features, setFeatures] = useState("");
  const [active, setActive] = useState(true);
  const [caps, setCaps] = useState<Capabilities>(NO_CAPABILITIES);
  const [maxEmployees, setMaxEmployees] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(plan?.name ?? "");
    setPrice(plan ? String(plan.price_cents / 100) : "0");
    setFeatures(Array.isArray(plan?.features) ? (plan!.features as string[]).join("\n") : "");
    setActive(plan?.active ?? true);
    setCaps(normalizeCapabilities(plan?.capabilities));
    setMaxEmployees(plan?.max_employees != null ? String(plan.max_employees) : "");
  }, [open, plan]);

  const grantedCount = CAPABILITY_LABELS.filter((c) => caps[c.key]).length;
  const seatCap = maxEmployees.trim() === "" ? null : Math.max(1, Math.round(Number(maxEmployees)));
  const previewBullets = planBullets(caps, features.split("\n").map((f) => f.trim()).filter(Boolean));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{plan ? "Edit plan" : "New plan"}</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="pl-name">Name</Label>
            <Input id="pl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pro" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pl-price">Price (USD / month)</Label>
              <Input id="pl-price" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pl-cap">Capacity label</Label>
              {/* Derived from the seat limit rather than typed, so the pricing
                  card can't advertise a headcount the plan doesn't enforce. */}
              <Input id="pl-cap" value={seatLine(seatCap)} readOnly className="bg-muted/40 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-seats">Employee limit</Label>
            <Input
              id="pl-seats"
              type="number"
              min={1}
              placeholder="Leave blank for unlimited"
              value={maxEmployees}
              onChange={(e) => setMaxEmployees(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Approving a join request past this number is refused. Blank means unlimited.
            </p>
          </div>

          {/* The real gate. `features` below is only marketing copy for the
              pricing page — these checkboxes are what the app enforces. */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Included features</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{grantedCount} of {CAPABILITY_LABELS.length}</span>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setCaps(ALL_CAPABILITIES)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setCaps(NO_CAPABILITIES)}
                >
                  None
                </button>
              </div>
            </div>
            <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {CAPABILITY_LABELS.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-accent">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={caps[c.key]}
                    onChange={(e) => setCaps((p) => ({ ...p, [c.key]: e.target.checked }))}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">{c.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pl-feat">Extra bullets (one per line)</Label>
            <Textarea id="pl-feat" rows={3} value={features} onChange={(e) => setFeatures(e.target.value)}
              placeholder="Priority support" />
            <p className="text-xs text-muted-foreground">
              For things that aren't features above, like support terms. Lines that repeat a ticked feature are dropped.
            </p>
          </div>

          {/* What the public pricing card and the Billing page will show. Built
              from the ticks above, so the promise and the product stay in step. */}
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pricing card preview</p>
            <p className="mt-1.5 text-sm font-semibold text-foreground">{name || "Untitled plan"}</p>
            <p className="text-xs text-muted-foreground">
              ${(Number(price) || 0).toFixed(0)}/month · {seatLine(seatCap)}
            </p>
            <ul className="mt-2 space-y-0.5">
              {previewBullets.length === 0 && (
                <li className="text-xs text-muted-foreground">No features ticked — the card will list nothing.</li>
              )}
              {previewBullets.map((b) => (
                <li key={b} className="flex items-center gap-1.5 text-xs text-foreground">
                  <Star className="h-3 w-3 text-success" />{b}
                </li>
              ))}
            </ul>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span className="text-foreground">Visible on the public pricing page</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            disabled={!name.trim() || pending}
            onClick={() => onSave({
              name: name.trim(),
              price_cents: Math.max(0, Math.round(Number(price) * 100)),
              capacity: seatLine(seatCap),
              features: features.split("\n").map((f) => f.trim()).filter(Boolean),
              active,
              sort_order: plan?.sort_order ?? nextSort,
              capabilities: caps,
              max_employees: seatCap,
            })}
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- global settings ----------------------------- */

function GlobalSettingsPanel() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["app-settings", "payments_enabled"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings").select("value").eq("key", "payments_enabled").maybeSingle();
      if (error) throw error;
      return data?.value === true;
    },
  });

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.from("app_settings").upsert(
        { key: "payments_enabled", value: enabled, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["app-settings", "payments_enabled"] }); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Card payments</h2>
            <p className="text-sm text-muted-foreground">
              While off, the public pricing page says cash / invoice billing. Turn on once Stripe
              checkout is connected.
            </p>
          </div>
        </div>
        <label className="inline-flex cursor-pointer select-none items-center gap-2">
          <span className="text-sm text-muted-foreground">{q.data ? "On" : "Off"}</span>
          <input
            type="checkbox"
            className="relative h-5 w-9 appearance-none rounded-full bg-muted transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-background before:transition-transform before:content-[''] checked:bg-primary checked:before:translate-x-4"
            checked={!!q.data}
            disabled={q.isLoading || toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
        </label>
      </div>
      {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}

/* ----------------------------- free trial ----------------------------- */

/**
 * How long a new company gets, and on which plan. The clock starts when the
 * company is approved, so changing the length here only affects trials that
 * haven't started yet.
 */
function TrialSettingsPanel({ plans }: { plans: PlanRow[] }) {
  const qc = useQueryClient();
  const [days, setDays] = useState("");
  const [plan, setPlan] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["app-settings", "trial"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings").select("key, value").in("key", ["trial_days", "trial_plan"]);
      if (error) throw error;
      const byKey = new Map((data ?? []).map((r) => [r.key, r.value]));
      return {
        days: Number(byKey.get("trial_days") ?? 30),
        plan: String(byKey.get("trial_plan") ?? "Enterprise"),
      };
    },
  });

  useEffect(() => {
    if (!q.data) return;
    setDays(String(q.data.days));
    setPlan(q.data.plan);
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      const n = Math.max(0, Math.round(Number(days)));
      if (!Number.isFinite(n)) throw new Error("Trial length must be a number of days.");
      const stamp = new Date().toISOString();
      const { error } = await supabase.from("app_settings").upsert(
        [
          { key: "trial_days", value: n, updated_at: stamp },
          { key: "trial_plan", value: plan, updated_at: stamp },
        ],
        { onConflict: "key" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings", "trial"] });
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <Gift className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Free trial</h2>
          <p className="text-sm text-muted-foreground">
            Every new company starts on a trial of the plan below. The countdown begins when you
            approve the company, so nobody loses days waiting for review.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="w-32 space-y-1.5">
              <Label htmlFor="trial-days">Length (days)</Label>
              <Input id="trial-days" type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <div className="w-48 space-y-1.5">
              <Label htmlFor="trial-plan">Plan granted</Label>
              <select
                id="trial-plan"
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
                {/* Keep a saved value visible even if that plan was renamed. */}
                {plan && !plans.some((p) => p.name === plan) && <option value={plan}>{plan} (missing)</option>}
              </select>
            </div>
            <Button size="sm" disabled={q.isLoading || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {saved ? "Saved" : "Save"}
            </Button>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Setting the length to 0 gives new companies no trial at all.
          </p>
          {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        </div>
      </div>
    </div>
  );
}
