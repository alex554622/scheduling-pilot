import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarCheck, Plus, Trash2, Loader2, Ban, Check } from "lucide-react";

export const Route = createFileRoute("/_authenticated/availability")({
  component: AvailabilityPage,
});

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Slot = {
  id: string;
  employee_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  is_available: boolean;
  note: string | null;
};

function AvailabilityPage() {
  const { company, user, primaryRole, loading } = useAuth();
  const isManager = primaryRole === "company_admin" || primaryRole === "super_admin";
  const [target, setTarget] = useState<string | null>(null);

  const membersQ = useQuery({
    queryKey: ["availability-members", company?.id],
    enabled: !!company?.id && isManager,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles").select("id, full_name")
        .eq("company_id", company!.id).order("full_name");
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">Join a company first.</div>;

  const employeeId = (isManager && target) || user!.id;
  const members = membersQ.data ?? [];
  const viewingName = members.find((m) => m.id === employeeId)?.full_name;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Availability</h1>
        <p className="text-sm text-muted-foreground">
          The hours you can normally work each week. The schedule builder warns admins when a
          shift falls outside these windows.
        </p>
      </div>

      {isManager && members.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
          <Label htmlFor="who" className="text-xs text-muted-foreground">Viewing</Label>
          <select
            id="who"
            className="h-9 min-w-56 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            value={employeeId}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value={user!.id}>My availability</option>
            {members.filter((m) => m.id !== user!.id).map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
          {employeeId !== user!.id && (
            <span className="text-xs text-muted-foreground">Editing {viewingName}&rsquo;s availability</span>
          )}
        </div>
      )}

      <AvailabilityEditor companyId={company.id} employeeId={employeeId} />
    </div>
  );
}

function AvailabilityEditor({ companyId, employeeId }: { companyId: string; employeeId: string }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const [form, setForm] = useState({ start: "09:00", end: "17:00", available: true });

  const q = useQuery({
    queryKey: ["availability", employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_availability")
        .select("id, employee_id, weekday, start_time, end_time, is_available, note")
        .eq("employee_id", employeeId)
        .order("weekday").order("start_time");
      if (error) throw error;
      return (data ?? []) as Slot[];
    },
  });

  const add = useMutation({
    mutationFn: async (weekday: number) => {
      if (form.end <= form.start) throw new Error("End time must be after start time.");
      const { error } = await supabase.from("employee_availability").insert({
        company_id: companyId,
        employee_id: employeeId,
        weekday,
        start_time: form.start,
        end_time: form.end,
        is_available: form.available,
      });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["availability", employeeId] }); setAdding(null); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("employee_availability").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["availability", employeeId] }),
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const slots = q.data ?? [];

  return (
    <div className="space-y-4">
      {slots.length === 0 && !q.isLoading && (
        <div className="rounded-xl border border-border bg-primary-soft/40 p-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">No availability set.</span>{" "}
          While this is empty the scheduler treats every hour as workable and never raises an
          availability warning.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {DAYS.map((day, weekday) => {
          const daySlots = slots.filter((s) => s.weekday === weekday);
          return (
            <div key={day} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{day}</h3>
                <Button variant="ghost" size="sm" onClick={() => { setErr(null); setAdding(adding === weekday ? null : weekday); }}
                  aria-label={`Add availability for ${day}`}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {daySlots.length === 0 ? (
                <p className="text-xs text-muted-foreground">Not set</p>
              ) : (
                <ul className="space-y-1.5">
                  {daySlots.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
                      <span className="flex items-center gap-2 text-xs">
                        {s.is_available
                          ? <Check className="h-3.5 w-3.5 text-success" />
                          : <Ban className="h-3.5 w-3.5 text-destructive" />}
                        <span className={s.is_available ? "text-foreground" : "text-muted-foreground line-through"}>
                          {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}
                        </span>
                      </span>
                      <button
                        onClick={() => del.mutate(s.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label="Remove window"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {adding === weekday && (
                <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px]">From</Label>
                      <Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className="h-8" />
                    </div>
                    <div>
                      <Label className="text-[11px]">To</Label>
                      <Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className="h-8" />
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, available: true })}
                      className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium ${form.available ? "bg-success text-success-foreground" : "bg-secondary text-muted-foreground"}`}
                    >
                      Available
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, available: false })}
                      className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium ${!form.available ? "bg-destructive text-destructive-foreground" : "bg-secondary text-muted-foreground"}`}
                    >
                      Blackout
                    </button>
                  </div>
                  <Button size="sm" className="w-full" disabled={add.isPending} onClick={() => add.mutate(weekday)}>
                    {add.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <CalendarCheck className="mr-2 h-3.5 w-3.5" />}
                    Add window
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {err && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
