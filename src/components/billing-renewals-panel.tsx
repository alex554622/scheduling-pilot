import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CalendarClock, Receipt } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { billingDueLabel, fmtBillingDate } from "@/lib/billing";

interface BillingRow {
  company_id: string;
  company_name: string;
  company_status: string;
  sub_status: string;
  plan_name: string;
  amount_cents: number;
  period_end: string | null;
  days_until: number | null;
  overdue: boolean;
  admin_email: string | null;
}

/**
 * A heads-up, not a workbench. Managing a company's billing happens on that
 * company's own page under Companies, where the rest of its detail lives — this
 * only says who needs attention and sends you there.
 */
export function BillingRenewalsPanel() {
  const q = useQuery({
    queryKey: ["billing-overview"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("billing_overview");
      if (error) throw error;
      return (data ?? []) as BillingRow[];
    },
  });

  const rows = q.data ?? [];
  const overdue = rows.filter((r) => r.overdue);
  const soon = rows.filter((r) => !r.overdue && r.days_until != null && r.days_until >= 0 && r.days_until <= 7);
  const needsAttention = [...overdue, ...soon];

  if (q.isLoading || (!q.error && needsAttention.length === 0)) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
            <Receipt className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Billing &amp; renewals</h2>
            <p className="text-sm text-muted-foreground">
              {q.isLoading ? "Checking…" : "Nothing due in the next week."}
            </p>
          </div>
          <Button asChild size="sm" variant="outline" className="ml-auto">
            <Link to="/companies">Open Companies</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${overdue.length > 0 ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/10"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${overdue.length > 0 ? "bg-destructive/10 text-destructive" : "bg-warning/20 text-warning-foreground"}`}
          >
            {overdue.length > 0 ? <AlertTriangle className="h-5 w-5" /> : <CalendarClock className="h-5 w-5" />}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Billing &amp; renewals</h2>
            <p className="text-sm text-muted-foreground">
              {overdue.length > 0 && (
                <span className="font-medium text-destructive">
                  {overdue.length} past the billing date
                </span>
              )}
              {overdue.length > 0 && soon.length > 0 && " · "}
              {soon.length > 0 && <>{soon.length} due within a week</>}
            </p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/companies">Manage in Companies</Link>
        </Button>
      </div>

      <ul className="mt-4 space-y-1.5 border-t border-border/60 pt-3">
        {needsAttention.slice(0, 6).map((r) => (
          <li key={r.company_id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-medium text-foreground">{r.company_name}</span>
            <span className={r.overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
              {fmtBillingDate(r.period_end)} · {billingDueLabel(r.period_end)}
            </span>
          </li>
        ))}
        {needsAttention.length > 6 && (
          <li className="pt-1 text-xs text-muted-foreground">
            and {needsAttention.length - 6} more
          </li>
        )}
      </ul>

      {q.error && (
        <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}
    </div>
  );
}
