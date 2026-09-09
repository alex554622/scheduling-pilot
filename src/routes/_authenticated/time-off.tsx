import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { CalendarOff, Plus, Loader2, Check, X, Clock } from "lucide-react";

export const Route = createFileRoute("/_authenticated/time-off")({
  component: TimeOffPage,
});

type Status = "pending" | "approved" | "denied" | "cancelled";
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

  const decideMut = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Status }) => {
      const { error } = await supabase.from("time_off_requests").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["time-off"] }),
  });

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
                </div>
                <StatusBadge status={r.status} />
                {canManage && r.status === "pending" && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => decideMut.mutate({ id: r.id, status: "approved" })} disabled={decideMut.isPending}>
                      <Check className="h-4 w-4" /> Approve
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => decideMut.mutate({ id: r.id, status: "denied" })} disabled={decideMut.isPending}>
                      <X className="h-4 w-4" /> Deny
                    </Button>
                  </div>
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

function NewRequestDialog({ open, onClose, userId, companyId, onSaved }: { open: boolean; onClose: () => void; userId: string; companyId: string; onSaved: () => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [kind, setKind] = useState<Kind>("vacation");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (!start || !end) throw new Error("Pick both dates");
      if (end < start) throw new Error("End date must be on or after start date");
      const { error } = await supabase.from("time_off_requests").insert({
        employee_id: userId,
        company_id: companyId,
        start_date: start,
        end_date: end,
        kind,
        note: note.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setStart(""); setEnd(""); setKind("vacation"); setNote(""); setErr(null);
      onSaved();
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request time off</DialogTitle>
          <DialogDescription>A company admin will review and respond.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="s">From</Label><Input id="s" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="e">To</Label><Input id="e" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
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
