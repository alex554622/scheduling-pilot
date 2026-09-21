import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ScrollText, ChevronDown, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/audit-log")({
  component: AuditLogPage,
});

type Entry = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_id: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
};

const ENTITIES = ["all", "shift", "schedule", "time_off_request", "shift_trade", "user_role", "company_subscription"] as const;

const ENTITY_LABEL: Record<string, string> = {
  all: "Everything",
  shift: "Shifts",
  schedule: "Schedules",
  time_off_request: "Time off",
  shift_trade: "Trades",
  user_role: "Roles",
  company_subscription: "Billing",
};

const OP_TONE: Record<string, string> = {
  insert: "bg-success/15 text-success",
  update: "bg-primary-soft text-primary",
  delete: "bg-destructive/10 text-destructive",
};

const PAGE = 50;

function AuditLogPage() {
  const { company, primaryRole, loading } = useAuth();
  const navigate = useNavigate();
  const [entity, setEntity] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";

  useEffect(() => {
    if (!loading && primaryRole && !isManager) navigate({ to: "/dashboard" });
  }, [loading, primaryRole, isManager, navigate]);

  const q = useQuery({
    queryKey: ["audit-log", company?.id, entity, page],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      let query = supabase
        .from("audit_logs")
        .select("id, action, entity_type, entity_id, actor_id, before, after, created_at")
        .eq("company_id", company!.id)
        .order("created_at", { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (entity !== "all") query = query.eq("entity_type", entity);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Entry[];
    },
  });

  // Resolve actor ids to names in one round trip rather than per row.
  const actorsQ = useQuery({
    queryKey: ["audit-actors", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id, full_name").eq("company_id", company!.id);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((p) => [p.id, p.full_name])) as Record<string, string>;
    },
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">Join a company first.</div>;

  const rows = q.data ?? [];
  const actors = actorsQ.data ?? {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every schedule edit, approval, role change, and billing change for {company.name}.
          Entries are written by the database itself and cannot be edited or forged from the app.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
        {ENTITIES.map((e) => (
          <button
            key={e}
            onClick={() => { setEntity(e); setPage(0); }}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${entity === e ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
          >
            {ENTITY_LABEL[e]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {q.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            <ScrollText className="mx-auto mb-2 h-6 w-6 opacity-40" />
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const op = r.action.split(".")[1] ?? "";
              const open = expanded === r.id;
              return (
                <li key={r.id}>
                  <button
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
                    onClick={() => setExpanded(open ? null : r.id)}
                  >
                    {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${OP_TONE[op] ?? "bg-secondary text-muted-foreground"}`}>
                      {op || "?"}
                    </span>
                    {/* On a phone the timestamp goes under the entry rather than
                        beside it: side by side it took the room the name needed,
                        and "who did this" is the point of an audit log. */}
                    <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                      <span className="block truncate text-sm text-foreground sm:flex-1">
                        {ENTITY_LABEL[r.entity_type] ?? r.entity_type}
                        <span className="text-muted-foreground"> · {r.actor_id ? (actors[r.actor_id] ?? "Unknown user") : "System"}</span>
                      </span>
                      <span className="block text-xs text-muted-foreground sm:shrink-0">
                        {new Date(r.created_at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div className="grid gap-3 border-t border-border bg-muted/30 p-4 md:grid-cols-2">
                      <DiffBlock label="Before" value={r.before} />
                      <DiffBlock label="After" value={r.after} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          ← Newer
        </Button>
        <span className="text-xs text-muted-foreground">Page {page + 1}</span>
        <Button variant="outline" size="sm" disabled={rows.length < PAGE} onClick={() => setPage((p) => p + 1)}>
          Older →
        </Button>
      </div>
    </div>
  );
}

function DiffBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {value == null ? (
        <p className="text-xs italic text-muted-foreground">none</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-card p-3 text-[11px] leading-relaxed text-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
