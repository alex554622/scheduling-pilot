import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { planBullets, seatLine } from "@/lib/capabilities";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CreditCard, AlertTriangle, CheckCircle2, Loader2, Users } from "lucide-react";

export const Route = createFileRoute("/_authenticated/billing")({
  component: BillingPage,
});

type Subscription = {
  id: string;
  status: string;
  plan_id: string | null;
  seats_limit: number | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

type Plan = { id: string; name: string; price_cents: number; capacity: string; features: unknown; capabilities: unknown; max_employees: number | null };

const STATUS_TONE: Record<string, { label: string; cls: string }> = {
  trialing: { label: "Trial", cls: "bg-primary-soft text-primary" },
  active: { label: "Active", cls: "bg-success/15 text-success" },
  past_due: { label: "Past due", cls: "bg-warning/20 text-warning-foreground" },
  canceled: { label: "Canceled", cls: "bg-destructive/10 text-destructive" },
  inactive: { label: "Inactive", cls: "bg-destructive/10 text-destructive" },
};

function BillingPage() {
  const { company, primaryRole, loading } = useAuth();
  const qc = useQueryClient();
  const isSuper = primaryRole === "super_admin";
  const [err, setErr] = useState<string | null>(null);

  const subQ = useQuery({
    queryKey: ["subscription", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_subscriptions")
        .select("id, status, plan_id, seats_limit, current_period_end, cancel_at_period_end")
        .eq("company_id", company!.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Subscription | null;
    },
  });

  const plansQ = useQuery({
    queryKey: ["pricing-plans-billing"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pricing_plans").select("id, name, price_cents, capacity, features, capabilities, max_employees")
        .eq("active", true).order("sort_order");
      if (error) throw error;
      return (data ?? []) as Plan[];
    },
  });

  const seatsQ = useQuery({
    queryKey: ["seat-count", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("profiles").select("id", { count: "exact", head: true })
        .eq("company_id", company!.id);
      if (error) throw error;
      return count ?? 0;
    },
  });

  // Only super admins may write billing — RLS enforces this too, so a company
  // admin pressing these would get zero rows updated rather than a silent success.
  const setStatus = useMutation({
    mutationFn: async (status: string) => {
      if (!subQ.data) throw new Error("No subscription row for this company yet.");
      const { error } = await supabase.from("company_subscriptions").update({ status }).eq("id", subQ.data.id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subscription"] }); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  // A super admin normally belongs to no company, so this page has nothing of
  // theirs to show. Point them at the platform-wide tools instead of a dead end.
  if (!company) {
    return isSuper ? (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Billing</h1>
          <p className="text-sm text-muted-foreground">
            This page shows one company&rsquo;s own subscription, and your account isn&rsquo;t attached to a company.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <p>Manage subscriptions per tenant from Companies, or see revenue and plans on Platform.</p>
          <div className="mt-3 flex gap-2">
            <Button asChild size="sm"><Link to="/companies">Go to Companies</Link></Button>
            <Button asChild size="sm" variant="outline"><Link to="/platform">Go to Platform</Link></Button>
          </div>
        </div>
      </div>
    ) : (
      <div className="text-sm text-muted-foreground">Join a company first.</div>
    );
  }

  const sub = subQ.data;
  const plans = plansQ.data ?? [];
  const currentPlan = plans.find((p) => p.id === sub?.plan_id);
  const seats = seatsQ.data ?? 0;
  const tone = STATUS_TONE[sub?.status ?? "trialing"] ?? STATUS_TONE.trialing;
  const blocked = sub && (sub.status === "inactive" || sub.status === "canceled");
  const overSeats = sub?.seats_limit != null && seats > sub.seats_limit;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground">Subscription status and plan for {company.name}.</p>
      </div>

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">New schedules are blocked</p>
            <p className="text-muted-foreground">
              Existing schedules and shifts stay visible to everyone, but no new schedule can be
              created until billing is restored.
            </p>
          </div>
        </div>
      )}

      {overSeats && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/15 p-4">
          <Users className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" />
          <div className="text-sm">
            <p className="font-medium text-warning-foreground">Over your seat limit</p>
            <p className="text-muted-foreground">
              {seats} people are in this company but the plan covers {sub!.seats_limit}.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CreditCard className="h-4 w-4 text-primary" /> Current subscription
          </div>

          {subQ.isLoading ? (
            <p className="py-6 text-sm text-muted-foreground">Loading…</p>
          ) : !sub ? (
            <p className="py-6 text-sm text-muted-foreground">
              No subscription record yet — this company is treated as being on trial and can
              schedule normally.
            </p>
          ) : (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone.cls}`}>{tone.label}</span>
              </dd>
              <dt className="text-muted-foreground">Plan</dt>
              <dd className="font-medium text-foreground">{currentPlan?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Seats</dt>
              <dd className="text-foreground">{seats}{sub.seats_limit != null ? ` / ${sub.seats_limit}` : ""}</dd>
              <dt className="text-muted-foreground">Renews</dt>
              <dd className="text-foreground">
                {sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : "—"}
              </dd>
            </dl>
          )}

          {isSuper && sub && (
            <div className="mt-5 border-t border-border pt-4">
              <Label className="text-xs text-muted-foreground">Platform admin — set status</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {["trialing", "active", "past_due", "inactive", "canceled"].map((s) => (
                  <Button key={s} size="sm" variant={sub.status === s ? "default" : "outline"}
                    disabled={setStatus.isPending} onClick={() => setStatus.mutate(s)}>
                    {setStatus.isPending && setStatus.variables === s && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                    {STATUS_TONE[s].label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {err && <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

          <p className="mt-5 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Card payments are not connected yet. Billing changes are made by the platform
            administrator; once Stripe is wired up, its webhook updates this record directly.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-medium text-foreground">Available plans</h2>
          <div className="mt-4 space-y-3">
            {plans.map((p) => {
              const isCurrent = p.id === sub?.plan_id;
              const features = planBullets(p.capabilities, p.features);
              return (
                <div key={p.id}
                  className={`rounded-xl border p-4 ${isCurrent ? "border-primary bg-primary-soft/40" : "border-border"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{seatLine(p.max_employees)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-foreground">${(p.price_cents / 100).toFixed(0)}</p>
                      <p className="text-[11px] text-muted-foreground">/month</p>
                    </div>
                  </div>
                  {features.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {features.map((f) => (
                        <li key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CheckCircle2 className="h-3 w-3 text-success" />{f}
                        </li>
                      ))}
                    </ul>
                  )}
                  {isCurrent && <p className="mt-2 text-xs font-medium text-primary">Current plan</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
