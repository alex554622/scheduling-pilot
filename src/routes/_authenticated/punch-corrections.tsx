import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, History, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/punch-corrections")({
  component: PunchCorrectionsPage,
});

type Punch = {
  id: string;
  user_id: string;
  kind: "in" | "out" | "break_start" | "break_end";
  at: string;
};

type AuditRow = {
  id: string;
  punch_id: string | null;
  user_id: string;
  actor_id: string;
  action: "create" | "update" | "delete";
  reason: string;
  before: any;
  after: any;
  created_at: string;
};

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(d: Date) { return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function fmtDT(s: string) { return new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function toLocalInput(s: string) {
  const d = new Date(s);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABEL: Record<string, string> = {
  in: "Clock IN",
  out: "Clock OUT",
  break_start: "Break start",
  break_end: "Break end",
};

function PunchCorrectionsPage() {
  const qc = useQueryClient();
  const { user, company, primaryRole, loading } = useAuth();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [selectedUser, setSelectedUser] = useState<string>("");
  const [editing, setEditing] = useState<Punch | null>(null);
  const [adding, setAdding] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  // Realtime: live-refresh punches and audit log for this company.
  useEffect(() => {
    if (!company?.id) return;
    const ch = supabase
      .channel(`corrections:${company.id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "time_punches", filter: `company_id=eq.${company.id}` },
        () => qc.invalidateQueries({ queryKey: ["correct-punches"] }))
      .on("postgres_changes",
        { event: "*", schema: "public", table: "time_punch_audit", filter: `company_id=eq.${company.id}` },
        () => qc.invalidateQueries({ queryKey: ["correct-audit"] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [company?.id, qc]);

  const rangeStart = anchor;
  const rangeEnd = addDays(anchor, 7);

  const rosterQ = useQuery({
    queryKey: ["correct-roster", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", company!.id)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const targetUserId = selectedUser || rosterQ.data?.[0]?.id;

  const punchesQ = useQuery<Punch[]>({
    queryKey: ["correct-punches", targetUserId, rangeStart.toISOString(), rangeEnd.toISOString()],
    enabled: !!targetUserId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punches")
        .select("id, user_id, kind, at")
        .eq("user_id", targetUserId!)
        .gte("at", rangeStart.toISOString())
        .lt("at", rangeEnd.toISOString())
        .order("at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Punch[];
    },
  });

  const auditQ = useQuery<AuditRow[]>({
    queryKey: ["correct-audit", targetUserId],
    enabled: !!targetUserId && showAudit,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_punch_audit")
        .select("*")
        .eq("user_id", targetUserId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
  });

  const updateMut = useMutation({
    mutationFn: async (v: { id: string; at: string; kind: string; reason: string }) => {
      const { error } = await supabase.rpc("manager_update_punch", {
        _id: v.id, _at: v.at, _kind: v.kind as any, _reason: v.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Punch updated");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["correct-punches"] });
      qc.invalidateQueries({ queryKey: ["correct-audit"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Update failed"),
  });

  const insertMut = useMutation({
    mutationFn: async (v: { user_id: string; at: string; kind: string; reason: string }) => {
      const { error } = await supabase.rpc("manager_insert_punch", {
        _user_id: v.user_id, _at: v.at, _kind: v.kind as any, _reason: v.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Punch added");
      setAdding(false);
      qc.invalidateQueries({ queryKey: ["correct-punches"] });
      qc.invalidateQueries({ queryKey: ["correct-audit"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Insert failed"),
  });

  const deleteMut = useMutation({
    mutationFn: async (v: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("manager_delete_punch", { _id: v.id, _reason: v.reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Punch deleted");
      qc.invalidateQueries({ queryKey: ["correct-punches"] });
      qc.invalidateQueries({ queryKey: ["correct-audit"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Delete failed"),
  });

  const rosterMap = useMemo(() => {
    const m = new Map<string, string>();
    (rosterQ.data ?? []).forEach((r: any) => m.set(r.id, r.full_name || "Unnamed"));
    return m;
  }, [rosterQ.data]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">Join a company first.</div>;
  if (!isManager) return <div className="text-sm text-muted-foreground">Manager access required.</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Punch corrections</h1>
          <p className="text-sm text-muted-foreground">
            Override or correct employee time punches. Every change is logged with a reason.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/timecards"><Clock className="mr-2 h-4 w-4" />Timecards</Link>
          </Button>
          <Button variant={showAudit ? "default" : "outline"} size="sm" onClick={() => setShowAudit((v) => !v)}>
            <History className="mr-2 h-4 w-4" />Audit log
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
        <select
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={targetUserId ?? ""}
          onChange={(e) => setSelectedUser(e.target.value)}
        >
          {(rosterQ.data ?? []).map((m: any) => (
            <option key={m.id} value={m.id}>{m.full_name || "Unnamed"}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDays(a, -7))}><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(startOfWeek(new Date()))}>This week</Button>
          <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDays(a, 7))}><ChevronRight className="h-4 w-4" /></Button>
          <Button size="sm" onClick={() => setAdding(true)} disabled={!targetUserId}>
            <Plus className="mr-2 h-4 w-4" />Add punch
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Week of {fmtDate(rangeStart)} – {fmtDate(addDays(rangeEnd, -1))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>Kind</div>
          <div>When</div>
          <div>ID</div>
          <div className="text-right">Actions</div>
        </div>
        {(punchesQ.data ?? []).length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground">No punches in this week.</div>
        )}
        {(punchesQ.data ?? []).map((p) => (
          <div key={p.id} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2 border-b border-border px-4 py-3 text-sm last:border-0">
            <div className="font-medium text-foreground">{KIND_LABEL[p.kind]}</div>
            <div className="text-foreground">{fmtDT(p.at)}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{p.id.slice(0, 8)}</div>
            <div className="flex justify-end gap-1">
              <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const reason = window.prompt("Reason for deleting this punch?");
                  if (reason && reason.trim().length >= 3) deleteMut.mutate({ id: p.id, reason });
                  else if (reason !== null) toast.error("Reason must be at least 3 characters");
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {showAudit && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent audit entries (last 50)
          </div>
          {(auditQ.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">No audit entries yet.</div>
          )}
          {(auditQ.data ?? []).map((a) => (
            <div key={a.id} className="border-b border-border px-4 py-3 text-sm last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  a.action === "create" ? "bg-emerald-100 text-emerald-700" :
                  a.action === "update" ? "bg-amber-100 text-amber-700" :
                  "bg-red-100 text-red-700"
                }`}>{a.action.toUpperCase()}</span>
                <span className="text-xs text-muted-foreground">{fmtDT(a.created_at)}</span>
                <span className="text-xs text-muted-foreground">by {rosterMap.get(a.actor_id) ?? a.actor_id.slice(0, 8)}</span>
              </div>
              <div className="mt-1 text-foreground">{a.reason}</div>
              {(a.before || a.after) && (
                <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  {a.before && <div><span className="font-medium">Before:</span> {KIND_LABEL[a.before.kind] ?? a.before.kind} @ {fmtDT(a.before.at)}</div>}
                  {a.after && <div><span className="font-medium">After:</span> {KIND_LABEL[a.after.kind] ?? a.after.kind} @ {fmtDT(a.after.at)}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(editing || adding) && (
        <PunchDialog
          mode={editing ? "edit" : "add"}
          initial={editing ?? undefined}
          targetUserId={targetUserId!}
          targetUserName={rosterMap.get(targetUserId!) ?? "Employee"}
          busy={updateMut.isPending || insertMut.isPending}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSubmit={(v) => {
            if (editing) updateMut.mutate({ id: editing.id, at: v.at, kind: v.kind, reason: v.reason });
            else insertMut.mutate({ user_id: targetUserId!, at: v.at, kind: v.kind, reason: v.reason });
          }}
        />
      )}
    </div>
  );
}

function PunchDialog({
  mode, initial, targetUserName, busy, onClose, onSubmit,
}: {
  mode: "edit" | "add";
  initial?: Punch;
  targetUserId: string;
  targetUserName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: { at: string; kind: string; reason: string }) => void;
}) {
  const [kind, setKind] = useState<string>(initial?.kind ?? "in");
  const [at, setAt] = useState<string>(initial ? toLocalInput(initial.at) : toLocalInput(new Date().toISOString()));
  const [reason, setReason] = useState("");

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-foreground/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-foreground">
          {mode === "edit" ? "Edit punch" : "Add punch"} · {targetUserName}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Manager override. A reason is required and the change will be logged.
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="kind">Type</Label>
            <select
              id="kind"
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="in">Clock IN</option>
              <option value="out">Clock OUT</option>
              <option value="break_start">Break start</option>
              <option value="break_end">Break end</option>
            </select>
          </div>
          <div>
            <Label htmlFor="at">Date &amp; time</Label>
            <Input id="at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              placeholder="e.g. Employee forgot to clock out; verified via timesheet."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            disabled={busy || reason.trim().length < 3 || !at}
            onClick={() => onSubmit({ at: new Date(at).toISOString(), kind, reason: reason.trim() })}
          >
            {busy ? "Saving…" : mode === "edit" ? "Save change" : "Add punch"}
          </Button>
        </div>
      </div>
    </div>
  );
}
