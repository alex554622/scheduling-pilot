import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useStaffVisibility } from "@/lib/staff-visibility";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { RefreshCw, Plus, Loader2, Check, X, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/trades")({
  component: TradesPage,
});

interface Trade {
  id: string;
  shift_id: string;
  to_shift_id: string | null;
  from_employee_id: string;
  to_employee_id: string;
  status: string;
  company_id: string;
  created_at: string;
}
interface ShiftRow {
  id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  position: string;
  published: boolean;
}

function fmtRange(a: string, b: string) {
  const s = new Date(a), e = new Date(b);
  return `${s.toLocaleDateString([], { month: "short", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${e.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function TradesPage() {
  const { user, profile, primaryRole, loading } = useAuth();
  const staff = useStaffVisibility();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const companyId = profile?.company_id ?? null;
  const canAdminister = primaryRole === "company_admin" || primaryRole === "super_admin";

  const tradesQ = useQuery({
    queryKey: ["trades", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_trades")
        .select("*")
        .eq("company_id", companyId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Trade[];
    },
  });

  const shiftsQ = useQuery({
    queryKey: ["trades-shifts", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, position, published")
        .eq("company_id", companyId!)
        .gte("starts_at", new Date().toISOString())
        .order("starts_at");
      if (error) throw error;
      return (data ?? []) as ShiftRow[];
    },
  });

  const peopleQ = useQuery({
    queryKey: ["members-mini", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("company_id", companyId!)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const shiftById = useMemo(() => {
    const m = new Map<string, ShiftRow>();
    (shiftsQ.data ?? []).forEach((s) => m.set(s.id, s));
    return m;
  }, [shiftsQ.data]);
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    (peopleQ.data ?? []).forEach((p) => m.set(p.id, p.full_name || "Unnamed"));
    return m;
  }, [peopleQ.data]);

  const [actionError, setActionError] = useState<string | null>(null);

  function refreshAll() {
    setActionError(null);
    for (const key of ["trades", "shifts", "trades-shifts"]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }

  /**
   * Every state change goes through a database function now. Approval used to
   * be two writes from this browser — flip the status, then move the shift —
   * which could leave a trade marked approved with the roster unchanged.
   */
  const respondMut = useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      const { error } = await supabase.rpc("respond_to_trade", { _trade: id, _accept: accept });
      if (error) throw error;
    },
    onSuccess: refreshAll,
    onError: (e: Error) => setActionError(e.message),
  });

  const approveMut = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      const { error } = await supabase.rpc("approve_trade", { _trade: id, _approve: approve });
      if (error) throw error;
    },
    onSuccess: refreshAll,
    onError: (e: Error) => setActionError(e.message),
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("shift_trades").update({ status: "cancelled" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refreshAll,
    onError: (e: Error) => setActionError(e.message),
  });

  const busy = respondMut.isPending || approveMut.isPending || cancelMut.isPending;

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!companyId) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Join a company to use shift trades.</div>;

  const trades = tradesQ.data ?? [];
  const myShifts = (shiftsQ.data ?? []).filter((s) => s.employee_id === user?.id && s.published);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Shift trades</h2>
          <p className="text-sm text-muted-foreground">Propose a swap with a teammate. Both they and a company admin must approve.</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={myShifts.length === 0}>
          <Plus className="h-4 w-4" /> Propose trade
        </Button>
      </div>

      {/* Without this the button is simply greyed out with no reason given,
          which reads as broken rather than "there's nothing to trade yet". */}
      {!shiftsQ.isLoading && myShifts.length === 0 && (
        <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          You have no upcoming published shifts, so there's nothing to trade yet. Shifts appear here once a
          manager builds the schedule and posts it.
        </p>
      )}

      <div className="rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
        {actionError && (
          <p className="border-b border-border bg-destructive/10 px-5 py-3 text-sm text-destructive">{actionError}</p>
        )}
        <div className="border-b border-border px-5 py-4">
          <h3 className="font-semibold text-foreground">All trade requests</h3>
        </div>
        {tradesQ.isLoading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : trades.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No trade requests yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {trades.map((t) => {
              const shift = shiftById.get(t.shift_id);
              const returnShift = t.to_shift_id ? shiftById.get(t.to_shift_id) : null;
              const isFrom = t.from_employee_id === user?.id;
              const isTo = t.to_employee_id === user?.id;
              const canEmployeeAct = isTo && t.status === "pending_employee";
              // "pending_supervisor" is the stored status from when supervisors were
              // their own role; it now just means "waiting on a company admin".
              const canAdminAct = canAdminister && t.status === "pending_supervisor";
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary-soft text-primary">
                    <RefreshCw className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {nameOf.get(t.from_employee_id) ?? "Member"} <ArrowRight className="inline h-3 w-3 text-muted-foreground" /> {nameOf.get(t.to_employee_id) ?? "Member"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Gives: {shift ? `${fmtRange(shift.starts_at, shift.ends_at)}${shift.position ? " · " + shift.position : ""}` : "Shift no longer available"}
                    </p>
                    {/* Only a two-way swap has a return leg; a hand-off has none. */}
                    {t.to_shift_id && (
                      <p className="text-xs text-muted-foreground">
                        Takes: {returnShift ? `${fmtRange(returnShift.starts_at, returnShift.ends_at)}${returnShift.position ? " · " + returnShift.position : ""}` : "Shift no longer available"}
                      </p>
                    )}
                  </div>
                  <TradeBadge status={t.status} />
                  {canEmployeeAct && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => respondMut.mutate({ id: t.id, accept: true })}>
                        <Check className="h-4 w-4" /> Accept
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => respondMut.mutate({ id: t.id, accept: false })}>
                        <X className="h-4 w-4" /> Decline
                      </Button>
                    </div>
                  )}
                  {canAdminAct && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => approveMut.mutate({ id: t.id, approve: true })}>
                        <Check className="h-4 w-4" /> Approve
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => approveMut.mutate({ id: t.id, approve: false })}>
                        <X className="h-4 w-4" /> Deny
                      </Button>
                    </div>
                  )}
                  {isFrom && t.status === "pending_employee" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => cancelMut.mutate(t.id)}>Cancel</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ProposeTradeDialog
        open={open}
        onClose={() => setOpen(false)}
        userId={user!.id}
        companyId={companyId}
        myShifts={myShifts}
        allShifts={shiftsQ.data ?? []}
        /* Someone an employee can't see on the schedule isn't someone they can
           offer a shift to either, so the picker drops the admins too. */
        teammates={staff.visible(
          (peopleQ.data ?? []).filter((p) => p.id !== user?.id),
          (p) => p.id,
        )}
        onSaved={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["trades"] }); }}
      />
    </div>
  );
}

function TradeBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    pending_employee: ["bg-warning/20 text-warning-foreground", "Awaiting teammate"],
    pending_supervisor: ["bg-primary-soft text-primary", "Awaiting admin"],
    approved: ["bg-success-soft text-success", "Approved"],
    denied: ["bg-destructive/15 text-destructive", "Denied"],
    cancelled: ["bg-muted text-muted-foreground", "Cancelled"],
  };
  const [cls, label] = map[status] ?? ["bg-muted text-muted-foreground", status];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span>;
}

function ProposeTradeDialog({ open, onClose, userId, companyId, myShifts, allShifts, teammates, onSaved }: {
  open: boolean; onClose: () => void; userId: string; companyId: string;
  myShifts: ShiftRow[]; allShifts: ShiftRow[];
  teammates: { id: string; full_name: string }[]; onSaved: () => void;
}) {
  const [shiftId, setShiftId] = useState("");
  const [toId, setToId] = useState("");
  const [toShiftId, setToShiftId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const theirShifts = allShifts.filter((s) => s.employee_id === toId && s.published);

  const submit = useMutation({
    mutationFn: async () => {
      if (!shiftId || !toId) throw new Error("Pick a shift and a teammate");
      const { error } = await supabase.from("shift_trades").insert({
        shift_id: shiftId,
        from_employee_id: userId,
        to_employee_id: toId,
        to_shift_id: toShiftId || null,
        company_id: companyId,
        status: "pending_employee",
      });
      if (error) throw error;
    },
    onSuccess: () => { setShiftId(""); setToId(""); setToShiftId(""); setErr(null); onSaved(); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose a shift trade</DialogTitle>
          <DialogDescription>Pick one of your published shifts and who you want to trade with. Optionally take one of theirs in return.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="sh">Your shift to trade away</Label>
            <select id="sh" value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="">Select a shift…</option>
              {myShifts.map((s) => (
                <option key={s.id} value={s.id}>{fmtRange(s.starts_at, s.ends_at)}{s.position ? ` · ${s.position}` : ""}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">Trade with</Label>
            <select
              id="to"
              value={toId}
              onChange={(e) => { setToId(e.target.value); setToShiftId(""); }}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="">Select teammate…</option>
              {teammates.map((p) => (<option key={p.id} value={p.id}>{p.full_name || "Unnamed"}</option>))}
            </select>
          </div>

          {/* Optional second leg. Leaving it blank is a straight hand-off —
              they cover your shift and give nothing up. */}
          {toId && (
            <div className="space-y-1.5">
              <Label htmlFor="toshift">Take their shift in return (optional)</Label>
              <select
                id="toshift"
                value={toShiftId}
                onChange={(e) => setToShiftId(e.target.value)}
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                disabled={theirShifts.length === 0}
              >
                <option value="">
                  {theirShifts.length === 0 ? "They have no upcoming shifts" : "Nothing — just cover mine"}
                </option>
                {theirShifts.map((s) => (
                  <option key={s.id} value={s.id}>{fmtRange(s.starts_at, s.ends_at)}{s.position ? ` · ${s.position}` : ""}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Pick one to make it a straight swap; leave it blank to just hand yours over.
              </p>
            </div>
          )}
          {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
