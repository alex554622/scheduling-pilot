import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import type { DateRange } from "react-day-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { CalendarOff, Plus, Loader2, Check, X, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/time-off")({
  component: TimeOffPage,
});

type Kind = "vacation" | "sick" | "personal" | "other";

interface RequestRow {
  id: string;
  employee_id: string;
  company_id: string;
  start_date: string;
  end_date: string;
  kind: string;
  status: string;
  note: string | null;
  created_at: string;
}

function fmtDate(s: string) {
  return new Date(s + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
/** A timestamp's calendar date in this browser's zone, as YYYY-MM-DD. */
function localDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtShift(a: string, b: string) {
  const s = new Date(a), e = new Date(b);
  const t = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${t(s)}–${t(e)}`;
}
function days(a: string, b: string) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1;
}

function TimeOffPage() {
  const { user, profile, primaryRole, loading } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const companyId = profile?.company_id ?? null;
  const canManage = primaryRole === "company_admin" || primaryRole === "super_admin";

  const reqQ = useQuery({
    queryKey: ["time-off", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_off_requests")
        .select("*")
        .eq("company_id", companyId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as RequestRow[];
    },
  });

  const peopleQ = useQuery({
    queryKey: ["members-mini", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (peopleQ.data ?? []).forEach((p) => m.set(p.id, p.full_name || "Unnamed"));
    return m;
  }, [peopleQ.data]);

  // The shifts each pending request would take someone off, so an admin sees
  // the gap an approval opens before they approve it rather than after.
  const pendingReqs = (reqQ.data ?? []).filter((r) => r.status === "pending");
  const shiftsQ = useQuery({
    queryKey: ["time-off-shifts", companyId, pendingReqs.map((r) => r.id).join(",")],
    enabled: !!companyId && canManage && pendingReqs.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at")
        .eq("company_id", companyId!)
        .in("employee_id", [...new Set(pendingReqs.map((r) => r.employee_id))])
        .gt("ends_at", new Date().toISOString());
      if (error) throw error;
      return data ?? [];
    },
  });

  function shiftsCovered(r: RequestRow) {
    return (shiftsQ.data ?? []).filter((s) => {
      if (s.employee_id !== r.employee_id) return false;
      const start = localDate(s.starts_at), end = localDate(s.ends_at);
      return start <= r.end_date && end >= r.start_date;
    });
  }

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    for (const key of ["time-off", "time-off-shifts", "shifts", "schedule-time-off"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }

  /**
   * Goes through decide_time_off so approval and taking the person off their
   * shifts happen together — a bare status update left them on the roster.
   */
  const decideMut = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      const { data, error } = await supabase.rpc("decide_time_off", { _request: id, _approve: approve });
      if (error) throw error;
      return { approve, opened: (data as number | null) ?? 0 };
    },
    onMutate: () => { setActionError(null); setNotice(null); },
    onSuccess: ({ approve, opened }) => {
      if (approve && opened > 0) {
        setNotice(`Approved. ${opened} shift${opened === 1 ? " is" : "s are"} now open on the schedule for someone to pick up.`);
      }
      refresh();
    },
    onError: (e: Error) => setActionError(e.message),
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("cancel_time_off", { _request: id });
      if (error) throw error;
    },
    onMutate: () => { setActionError(null); setNotice(null); },
    onSuccess: refresh,
    onError: (e: Error) => setActionError(e.message),
  });

  const busy = decideMut.isPending || cancelMut.isPending;

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!companyId) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Join a company to use time off.</div>;

  const all = reqQ.data ?? [];
  const mine = all.filter((r) => r.employee_id === user?.id);
  const pending = all.filter((r) => r.status === "pending");
  const visible = canManage ? all : mine;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Time off</h2>
          <p className="text-sm text-muted-foreground">
            {canManage ? `Review your team's requests. ${pending.length} pending.` : "Submit and track your time-off requests."}
          </p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New request</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Pending" value={pending.length} tone="warning" />
        <Stat label="Approved" value={all.filter((r) => r.status === "approved").length} tone="success" />
        <Stat label="Denied" value={all.filter((r) => r.status === "denied").length} tone="muted" />
      </div>

      <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
        {actionError && (
          <p className="border-b border-border bg-destructive/10 px-5 py-3 text-sm text-destructive">{actionError}</p>
        )}
        {notice && (
          <p className="border-b border-border bg-success-soft px-5 py-3 text-sm text-success">{notice}</p>
        )}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="font-semibold text-foreground">{canManage ? "All requests" : "My requests"}</h3>
        </div>
        {reqQ.isLoading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No requests yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary-soft text-primary">
                  <CalendarOff className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {nameOf.get(r.employee_id) ?? "Member"} · <span className="capitalize text-muted-foreground">{r.kind}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDate(r.start_date)} – {fmtDate(r.end_date)} · {days(r.start_date, r.end_date)} day{days(r.start_date, r.end_date) === 1 ? "" : "s"}
                  </p>
                  {r.note && <p className="mt-1 text-xs text-muted-foreground italic">"{r.note}"</p>}
                  {canManage && r.status === "pending" && shiftsCovered(r).length > 0 && (
                    <p className="mt-1 text-xs text-warning-foreground">
                      Scheduled for {shiftsCovered(r).length} shift{shiftsCovered(r).length === 1 ? "" : "s"} in this range
                      ({shiftsCovered(r).map((s) => fmtShift(s.starts_at, s.ends_at)).join(", ")}). Approving
                      makes {shiftsCovered(r).length === 1 ? "it an open shift" : "them open shifts"}.
                    </p>
                  )}
                </div>
                <StatusBadge status={r.status} />
                {canManage && r.status === "pending" && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => decideMut.mutate({ id: r.id, approve: true })} disabled={busy}>
                      <Check className="h-4 w-4" /> Approve
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => decideMut.mutate({ id: r.id, approve: false })} disabled={busy}>
                      <X className="h-4 w-4" /> Deny
                    </Button>
                  </div>
                )}
                {r.employee_id === user?.id && r.status === "pending" && (
                  <Button size="sm" variant="ghost" onClick={() => cancelMut.mutate(r.id)} disabled={busy}>Cancel</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        userId={user!.id}
        companyId={companyId}
        onSaved={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["time-off"] }); }}
      />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "success" | "warning" | "muted" }) {
  const map = { success: "bg-success-soft text-success", warning: "bg-warning/20 text-warning-foreground", muted: "bg-muted text-muted-foreground" };
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-card)]">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-2xl font-semibold text-foreground">{value}</p>
        <div className={`grid h-9 w-9 place-items-center rounded-lg ${map[tone]}`}><Clock className="h-4 w-4" /></div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-warning/20 text-warning-foreground",
    approved: "bg-success-soft text-success",
    denied: "bg-destructive/15 text-destructive",
    cancelled: "bg-muted text-muted-foreground",
  };
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${styles[status] ?? "bg-muted text-muted-foreground"}`}>{status}</span>;
}

/**
 * Picked days folded into runs of consecutive dates, so Mon–Wed plus Friday is
 * two requests (Mon–Wed, Fri) rather than one that quietly covers Thursday.
 */
function toRuns(picked: Date[]): { start: string; end: string }[] {
  const keys = [...new Set(picked.map((d) => localDate(d.toISOString())))].sort();
  const runs: { start: string; end: string }[] = [];
  for (const k of keys) {
    const last = runs[runs.length - 1];
    if (last && days(last.end, k) === 2) last.end = k;
    else runs.push({ start: k, end: k });
  }
  return runs;
}

function NewRequestDialog({ open, onClose, userId, companyId, onSaved }: { open: boolean; onClose: () => void; userId: string; companyId: string; onSaved: () => void }) {
  const [mode, setMode] = useState<"days" | "range">("days");
  const [picked, setPicked] = useState<Date[]>([]);
  const [range, setRange] = useState<DateRange | undefined>();
  const [kind, setKind] = useState<Kind>("vacation");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const runs = useMemo(() => {
    if (mode === "days") return toRuns(picked);
    if (!range?.from) return [];
    const s = localDate(range.from.toISOString());
    return [{ start: s, end: range.to ? localDate(range.to.toISOString()) : s }];
  }, [mode, picked, range]);
  const dayCount = runs.reduce((n, r) => n + days(r.start, r.end), 0);

  function reset() {
    setPicked([]); setRange(undefined); setKind("vacation"); setNote(""); setErr(null);
  }

  const submit = useMutation({
    mutationFn: async () => {
      if (runs.length === 0) throw new Error("Pick at least one day");
      const { error } = await supabase.from("time_off_requests").insert(
        runs.map((r) => ({
          employee_id: userId,
          company_id: companyId,
          start_date: r.start,
          end_date: r.end,
          kind,
          note: note.trim() || null,
        })),
      );
      if (error) throw error;
    },
    onSuccess: () => {
      reset();
      onSaved();
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request time off</DialogTitle>
          <DialogDescription>Pick the days you need off. A company admin will review and respond.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto py-2">
          <div className="space-y-2">
            <div className="inline-flex rounded-lg bg-secondary p-1">
              {([["days", "Pick days"], ["range", "Date range"]] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === "days"
                ? "Tap each day you need off — they don't have to be next to each other."
                : "Tap the first day, then the last day."}
            </p>
            <div className="flex justify-center rounded-lg border border-border">
              {mode === "days" ? (
                <Calendar mode="multiple" selected={picked} onSelect={(d) => setPicked(d ?? [])} />
              ) : (
                <Calendar mode="range" selected={range} onSelect={setRange} />
              )}
            </div>
            {runs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  {dayCount} day{dayCount === 1 ? "" : "s"}:
                </span>
                {runs.map((r) => (
                  <span key={r.start} className="rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary">
                    {r.start === r.end ? fmtDate(r.start) : `${fmtDate(r.start)} – ${fmtDate(r.end)}`}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="k">Type</Label>
            <select id="k" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="vacation">Vacation</option>
              <option value="sick">Sick</option>
              <option value="personal">Personal</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="n">Note (optional)</Label>
            <Textarea id="n" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything your manager should know?" rows={3} />
          </div>
          {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
