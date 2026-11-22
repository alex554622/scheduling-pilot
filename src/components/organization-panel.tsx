import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { LeafletMap } from "@/components/leaflet-map";
import { Switch } from "@/components/ui/switch";
import { ORG_STRUCTURE_KEY, useOrgStructure } from "@/lib/use-org-structure";
import { activeOrCurrent, diffIds, type OrgItem } from "@/lib/org-structure";
import { useT } from "@/lib/i18n";
import { Building2, MapPin, BriefcaseBusiness, Plus, Trash2, Pencil, Loader2, Crosshair, Globe } from "lucide-react";

type Department = { id: string; name: string; description: string | null };
type Position = { id: string; name: string; description: string | null; color: string };
type Location = {
  id: string; name: string; address: string | null;
  latitude: number | null; longitude: number | null; geofence_radius_m: number;
};

/**
 * Departments, positions and locations. Shown as the
 * "Organization" tab of Settings; the old /organization address forwards there.
 */
export function OrganizationPanel() {
  const t = useT("people");
  const { company, primaryRole, loading } = useAuth();
  const navigate = useNavigate();

  // Company admins own the org structure (matches the RLS policies).
  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  if (loading) return <div className="text-sm text-muted-foreground">{t("Loading…")}</div>;
  if (!company) return <div className="text-sm text-muted-foreground">{t("Join a company first.")}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("Organization")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Departments, job positions, and worksites for {name}.", { name: company.name })}
        </p>
      </div>

      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general"><Globe className="mr-2 h-4 w-4" />{t("General")}</TabsTrigger>
          <TabsTrigger value="departments"><Building2 className="mr-2 h-4 w-4" />{t("Departments")}</TabsTrigger>
          <TabsTrigger value="positions"><BriefcaseBusiness className="mr-2 h-4 w-4" />{t("Positions")}</TabsTrigger>
          <TabsTrigger value="locations"><MapPin className="mr-2 h-4 w-4" />{t("Locations")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6"><GeneralTab companyId={company.id} /></TabsContent>
        <TabsContent value="departments" className="mt-6"><DepartmentsTab companyId={company.id} /></TabsContent>
        <TabsContent value="positions" className="mt-6"><PositionsTab companyId={company.id} /></TabsContent>
        <TabsContent value="locations" className="mt-6"><LocationsTab companyId={company.id} /></TabsContent>
      </Tabs>
    </div>
  );
}

/* --------------------------------- shared --------------------------------- */

function Panel({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
}

/* --------------------------------- general --------------------------------- */

// Availability and blackout windows are wall-clock times, so the conflict
// engine has to convert each shift into the company's local zone before it can
// compare them. Left at the UTC default, a 9am-5pm Pacific shift lands at
// 16:00-00:00 UTC and gets wrongly reported as crossing midnight.
const COMMON_ZONES = [
  "America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago",
  "America/New_York", "America/Anchorage", "Pacific/Honolulu", "America/Toronto",
  "America/Mexico_City", "Europe/London", "Europe/Dublin", "Europe/Paris",
  "Europe/Berlin", "Europe/Madrid", "Europe/Warsaw", "Australia/Sydney",
  "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "UTC",
];

function GeneralTab({ companyId }: { companyId: string }) {
  const t = useT("people");
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const detected = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
  })();

  const q = useQuery({
    queryKey: ["company-timezone", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies").select("timezone").eq("id", companyId).maybeSingle();
      if (error) throw error;
      return data?.timezone ?? "UTC";
    },
  });

  const [tz, setTz] = useState<string | null>(null);
  const value = tz ?? q.data ?? "UTC";

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("companies").update({ timezone: value }).eq("id", companyId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-timezone"] });
      setErr(null); setSaved(true); setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const zones = Array.from(new Set([detected, ...COMMON_ZONES]));

  return (
    <div className="space-y-6">
    <OrgNamePanel companyId={companyId} />

    <Panel title={t("Scheduling timezone")} subtitle={t("Used to match shifts against stated availability and weekly hour totals.")}>
      <div className="max-w-md space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tz">{t("Timezone")}</Label>
          <select
            id="tz"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={value}
            onChange={(e) => setTz(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>{z}{z === detected ? `  ${t("(this device)")}` : ""}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t("This device reports")} <span className="font-medium text-foreground">{detected}</span>.{" "}
            {t("Leaving this on UTC while your team works in another zone makes ordinary day shifts look like they cross midnight.")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={save.isPending || value === q.data} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("Save timezone")}
          </Button>
          {saved && <span className="text-xs text-success">{t("Saved.")}</span>}
        </div>
        <ErrorNote error={err} />
      </div>
    </Panel>
    </div>
  );
}

/**
 * Renaming the organization. This is the first thing anyone looks for on this
 * page, and it is the name that turns up in the sidebar, on schedules and on
 * printed timecards - so it is worth a panel of its own above the timezone.
 *
 * No new database work: the company_admin_update policy already lets an admin
 * update their own company row, the same way the timezone above does.
 */
function OrgNamePanel({ companyId }: { companyId: string }) {
  const t = useT("people");
  const { company, refresh } = useAuth();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (company) setName(company.name ?? "");
  }, [company]);

  const save = useMutation({
    mutationFn: async () => {
      const next = name.trim();
      // `name` is NOT NULL, but an empty string satisfies that and would leave
      // the organization nameless everywhere it is displayed.
      if (!next) throw new Error(t("Organization name can't be empty"));
      if (next.length > 120) throw new Error(t("Organization name must be 120 characters or fewer"));
      const { error } = await supabase.from("companies").update({ name: next }).eq("id", companyId);
      if (error) throw error;
      // So the sidebar and every heading pick the new name up without a reload.
      await refresh();
    },
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const dirty = !!company && name.trim() !== company.name;

  return (
    <Panel
      title={t("Organization name")}
      subtitle={t("Shown to your team across the app, on schedules you publish, and on printed timecards.")}
    >
      <div className="max-w-md space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="org-name">{t("Name")}</Label>
          <Input
            id="org-name"
            value={name}
            maxLength={120}
            placeholder={t("e.g. City of Calexico")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) save.mutate();
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("Save name")}
          </Button>
          {saved && <span className="text-xs text-success">{t("Saved.")}</span>}
        </div>
        <ErrorNote error={err} />
      </div>
    </Panel>
  );
}

/* ------------------------------- departments ------------------------------- */

function DepartmentsTab({ companyId }: { companyId: string }) {
  const t = useT("people");
  const qc = useQueryClient();
  const org = useOrgStructure(companyId);
  const [editing, setEditing] = useState<Department | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["departments", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments").select("id, name, description")
        .eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as Department[];
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["departments"] });
    void qc.invalidateQueries({ queryKey: [ORG_STRUCTURE_KEY] });
  };

  const save = useMutation({
    mutationFn: async (v: OrgItemDraft & { id?: string }) => {
      const base = { name: v.name, description: v.description || null };
      const extra = org.missing ? {} : { is_active: v.isActive, location_id: v.locationId || null };
      let id = v.id;
      if (id) {
        const { error } = await supabase.from("departments").update({ ...base, ...extra }).eq("id", id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("departments")
          .insert({ company_id: companyId, ...base, ...extra }).select("id").single();
        if (error) throw error;
        id = data.id;
      }
      if (org.missing) return;
      const before = org.links.filter((l) => l.department_id === id).map((l) => l.position_id);
      const { add, remove } = diffIds(before, v.linked);
      if (add.length) {
        const { error } = await supabase.from("department_positions").insert(
          add.map((position_id) => ({ company_id: companyId, department_id: id!, position_id })),
        );
        if (error) throw error;
      }
      if (remove.length) {
        const { error } = await supabase.from("department_positions").delete()
          .eq("department_id", id).in("position_id", remove);
        if (error) throw error;
      }
    },
    onSuccess: () => { refresh(); setEditing(null); setCreating(false); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("departments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  // Who is in each department, and who supervises it. Supervisors are given
  // their departments on the Employees page, from the supervisor's row.
  const peopleQ = useQuery({
    queryKey: ["company-members-departments", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("company_members").select("id, full_name, department_id")
        .eq("company_id", companyId).eq("status", "active");
      if (error) throw error;
      return data ?? [];
    },
  });
  const assignQ = useQuery({
    queryKey: ["supervisor-assignments", companyId, "by-department"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supervisor_assignments").select("supervisor_id, department_id")
        .eq("company_id", companyId);
      // Before the supervisor migration is run the table is missing; the list
      // still works, just without supervisors.
      if (error) return [];
      return data ?? [];
    },
  });
  const nameById = new Map((peopleQ.data ?? []).map((p) => [p.id, p.full_name || t("Unnamed")]));
  const headcount = (deptId: string) =>
    (peopleQ.data ?? []).filter((p) => p.department_id === deptId).length;
  const supervisorsOf = (deptId: string) => [
    ...new Set(
      (assignQ.data ?? [])
        .filter((a) => a.department_id === deptId)
        .map((a) => nameById.get(a.supervisor_id) ?? t("Unnamed")),
    ),
  ];
  const orgDept = (id: string) => org.departments.find((d) => d.id === id);
  const locationName = (id: string | null | undefined) =>
    org.locations.find((l) => l.id === id)?.name ?? null;
  const positionsOf = (deptId: string) =>
    org.links
      .filter((l) => l.department_id === deptId)
      .map((l) => org.positions.find((p) => p.id === l.position_id)?.name)
      .filter(Boolean) as string[];

  const rows = q.data ?? [];
  const current = editing ? orgDept(editing.id) : undefined;

  return (
    <Panel
      title={t("Departments")}
      subtitle={t("Group people and shifts by department. Each department lists the positions people in it can hold.")}
      action={<Button size="sm" onClick={() => { setErr(null); setCreating(true); }}><Plus className="mr-2 h-4 w-4" />{t("Add department")}</Button>}
    >
      {q.isLoading ? <EmptyState>{t("Loading…")}</EmptyState>
        : rows.length === 0 ? <EmptyState>{t("No departments yet.")}</EmptyState>
        : (
          <ul className="divide-y divide-border">
            {rows.map((d) => {
              const od = orgDept(d.id);
              const loc = locationName(od?.location_id);
              const pos = positionsOf(d.id);
              return (
                <li key={d.id} className={`flex items-center justify-between gap-3 py-3 ${od && !od.is_active ? "opacity-60" : ""}`}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
                      {d.name}
                      {od && !od.is_active && <InactiveTag />}
                    </p>
                    {d.description && <p className="truncate text-xs text-muted-foreground">{d.description}</p>}
                    <p className="truncate text-xs text-muted-foreground">
                      {loc ? `${loc} · ` : ""}
                      {pos.length ? t("Positions: {names}", { names: pos.join(", ") }) : t("Any position")}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {headcount(d.id) === 1 ? t("1 person") : t("{n} people", { n: headcount(d.id) })}
                      {" · "}
                      {supervisorsOf(d.id).length === 0
                        ? t("No supervisor")
                        : t("Supervised by {names}", { names: supervisorsOf(d.id).join(", ") })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => { setErr(null); setEditing(d); }} aria-label={t("Edit {name}", { name: d.name })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        if (confirm(t("Delete “{name}”? People in it are left without a department. To keep it on old records, turn it off instead.", { name: d.name })))
                          del.mutate(d.id);
                      }}
                      aria-label={t("Delete {name}", { name: d.name })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      <ErrorNote error={err} />

      <OrgItemDialog
        open={creating || !!editing}
        title={editing ? t("Edit department") : t("New department")}
        initial={{
          name: editing?.name ?? "",
          description: editing?.description ?? "",
          isActive: current?.is_active ?? true,
          locationId: current?.location_id ?? "",
          linked: editing ? org.links.filter((l) => l.department_id === editing.id).map((l) => l.position_id) : [],
        }}
        missing={org.missing}
        locations={activeOrCurrent(org.locations, current?.location_id)}
        linkOptions={org.positions}
        linkLabel={t("Positions in this department")}
        linkHint={t("The Position dropdown in Edit member offers only these. Leave all unticked to allow any position.")}
        activeHint={t("Off: no one new can be put in this department. People already in it stay, and old records still show it.")}
        pending={save.isPending}
        onCancel={() => { setCreating(false); setEditing(null); }}
        onSave={(v) => save.mutate({ id: editing?.id, ...v })}
      />
    </Panel>
  );
}

interface OrgItemDraft {
  name: string;
  description: string;
  isActive: boolean;
  locationId: string;
  linked: string[];
}

function InactiveTag() {
  const t = useT("people");
  return (
    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {t("Inactive")}
    </span>
  );
}

/**
 * Name, description and the Active switch, for a department or a position;
 * a department also picks its location. The ticked list links positions and
 * departments, from whichever side is being edited.
 */
function OrgItemDialog({ open, title, initial, missing, locations, linkOptions, linkLabel, linkHint, activeHint, pending, onCancel, onSave }: {
  open: boolean; title: string; initial: OrgItemDraft; missing: boolean;
  locations?: OrgItem[]; linkOptions: OrgItem[]; linkLabel: string; linkHint: string; activeHint: string;
  pending: boolean; onCancel: () => void; onSave: (v: OrgItemDraft) => void;
}) {
  const t = useT("people");
  const [draft, setDraft] = useState<OrgItemDraft>(initial);
  const seed = JSON.stringify(initial);

  // Re-seed the form whenever a different row opens the dialog.
  useEffect(() => { setDraft(JSON.parse(seed) as OrgItemDraft); }, [seed, open]);

  const toggle = (id: string) =>
    setDraft((d) => ({ ...d, linked: d.linked.includes(id) ? d.linked.filter((x) => x !== id) : [...d.linked, id] }));
  const options = linkOptions.filter((o) => o.is_active || draft.linked.includes(o.id));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-2 pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="nd-name">{t("Name")}</Label>
            <Input id="nd-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("e.g. Traffic Division")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nd-desc">{t("Description")}</Label>
            <Textarea id="nd-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} />
          </div>
          {missing ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t("Apply the organization structure migration to turn items off and link positions to departments.")}
            </p>
          ) : (
            <>
              {locations && (
                <div className="space-y-1.5">
                  <Label htmlFor="nd-loc">{t("Location")}</Label>
                  <select id="nd-loc" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                    value={draft.locationId} onChange={(e) => setDraft({ ...draft, locationId: e.target.value })}>
                    <option value="">{t("— no location —")}</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.is_active ? "" : ` (${t("inactive")})`}</option>)}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>{linkLabel}</Label>
                {options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("None set up yet.")}</p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {options.map((o) => (
                      <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-sm hover:bg-accent">
                        <input type="checkbox" className="h-4 w-4" checked={draft.linked.includes(o.id)} onChange={() => toggle(o.id)} />
                        <span className="truncate text-foreground">{o.name}{o.is_active ? "" : ` (${t("inactive")})`}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{linkHint}</p>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/30 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{t("Active")}</div>
                  <div className="text-xs text-muted-foreground">{activeHint}</div>
                </div>
                <Switch checked={draft.isActive} onCheckedChange={(v) => setDraft({ ...draft, isActive: v })} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("Cancel")}</Button>
          <Button disabled={!draft.name.trim() || pending} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- positions -------------------------------- */

function PositionsTab({ companyId }: { companyId: string }) {
  const t = useT("people");
  const qc = useQueryClient();
  const org = useOrgStructure(companyId);
  const [editing, setEditing] = useState<Position | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["positions", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions").select("id, name, description, color")
        .eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as Position[];
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["positions"] });
    void qc.invalidateQueries({ queryKey: [ORG_STRUCTURE_KEY] });
    void qc.invalidateQueries({ queryKey: ["position-pay-rules"] });
  };

  const save = useMutation({
    mutationFn: async (v: OrgItemDraft & { id?: string }) => {
      const base = { name: v.name, description: v.description || null };
      const extra = org.missing ? {} : { is_active: v.isActive };
      let id = v.id;
      if (id) {
        const { error } = await supabase.from("positions").update({ ...base, ...extra }).eq("id", id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("positions")
          .insert({ company_id: companyId, ...base, ...extra }).select("id").single();
        if (error) throw error;
        id = data.id;
      }
      if (org.missing) return;
      const before = org.links.filter((l) => l.position_id === id).map((l) => l.department_id);
      const { add, remove } = diffIds(before, v.linked);
      if (add.length) {
        const { error } = await supabase.from("department_positions").insert(
          add.map((department_id) => ({ company_id: companyId, department_id, position_id: id! })),
        );
        if (error) throw error;
      }
      if (remove.length) {
        const { error } = await supabase.from("department_positions").delete()
          .eq("position_id", id).in("department_id", remove);
        if (error) throw error;
      }
    },
    onSuccess: () => { refresh(); setEditing(null); setCreating(false); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("positions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const orgPos = (id: string) => org.positions.find((p) => p.id === id);
  const departmentsOf = (posId: string) =>
    org.links
      .filter((l) => l.position_id === posId)
      .map((l) => org.departments.find((d) => d.id === l.department_id)?.name)
      .filter(Boolean) as string[];

  const rows = q.data ?? [];
  const current = editing ? orgPos(editing.id) : undefined;

  return (
    <Panel
      title={t("Positions")}
      subtitle={t("What people do, picked from Edit member. A position belongs to one or more departments; pay rules for positions are under App rules.")}
      action={<Button size="sm" onClick={() => { setErr(null); setCreating(true); }}><Plus className="mr-2 h-4 w-4" />{t("Add position")}</Button>}
    >
      {q.isLoading ? <EmptyState>{t("Loading…")}</EmptyState>
        : rows.length === 0 ? <EmptyState>{t("No positions yet.")}</EmptyState>
        : (
          <ul className="divide-y divide-border">
            {rows.map((p) => {
              const op = orgPos(p.id);
              const depts = departmentsOf(p.id);
              return (
                <li key={p.id} className={`flex items-center justify-between gap-3 py-3 ${op && !op.is_active ? "opacity-60" : ""}`}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
                      {p.name}
                      {op && !op.is_active && <InactiveTag />}
                    </p>
                    {p.description && <p className="truncate text-xs text-muted-foreground">{p.description}</p>}
                    {!org.missing && (
                      <p className="truncate text-xs text-muted-foreground">
                        {depts.length ? depts.join(", ") : t("Not in a department yet")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" onClick={() => { setErr(null); setEditing(p); }} aria-label={t("Edit {name}", { name: p.name })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        if (confirm(t("Delete “{name}”? People who hold it are left without a position. To keep it on old records, turn it off instead.", { name: p.name })))
                          del.mutate(p.id);
                      }}
                      aria-label={t("Delete {name}", { name: p.name })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      <ErrorNote error={err} />

      <OrgItemDialog
        open={creating || !!editing}
        title={editing ? t("Edit position") : t("New position")}
        initial={{
          name: editing?.name ?? "",
          description: editing?.description ?? "",
          isActive: current?.is_active ?? true,
          locationId: "",
          linked: editing ? org.links.filter((l) => l.position_id === editing.id).map((l) => l.department_id) : [],
        }}
        missing={org.missing}
        linkOptions={org.departments}
        linkLabel={t("Departments with this position")}
        linkHint={t("People in these departments can be given this position.")}
        activeHint={t("Off: no one new can be given this position. People who hold it keep it, and old records still show it.")}
        pending={save.isPending}
        onCancel={() => { setCreating(false); setEditing(null); }}
        onSave={(v) => save.mutate({ id: editing?.id, ...v })}
      />
    </Panel>
  );
}

/* -------------------------------- locations -------------------------------- */

function LocationsTab({ companyId }: { companyId: string }) {
  const t = useT("people");
  const qc = useQueryClient();
  const org = useOrgStructure(companyId);
  const isActive = (id: string) => org.locations.find((l) => l.id === id)?.is_active ?? true;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    id?: string; name: string; address: string;
    latitude: number | ""; longitude: number | ""; radius: number; isActive: boolean;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["locations", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations").select("id, name, address, latitude, longitude, geofence_radius_m")
        .eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as Location[];
    },
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      if (!draft.name.trim()) throw new Error(t("Give the location a name."));
      const payload = {
        name: draft.name.trim(),
        address: draft.address || null,
        latitude: draft.latitude === "" ? null : Number(draft.latitude),
        longitude: draft.longitude === "" ? null : Number(draft.longitude),
        geofence_radius_m: draft.radius,
        ...(org.missing ? {} : { is_active: draft.isActive }),
      };
      if (draft.id) {
        const { error } = await supabase.from("locations").update(payload).eq("id", draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("locations").insert({ company_id: companyId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] });
      qc.invalidateQueries({ queryKey: [ORG_STRUCTURE_KEY] });
      setDraft(null); setErr(null);
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("locations").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["locations"] }); setSelectedId(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  // Pins for every saved site; the draft pin follows the map click while editing.
  const pins = rows
    .filter((l) => l.latitude != null && l.longitude != null)
    .map((l) => ({ lat: l.latitude as number, lng: l.longitude as number, label: l.name }));

  const draftHasPoint = !!draft && draft.latitude !== "" && draft.longitude !== "";
  const selected = rows.find((l) => l.id === selectedId) ?? null;

  const focus: { lat: number; lng: number; radiusM: number } | undefined = draftHasPoint
    ? { lat: Number(draft!.latitude), lng: Number(draft!.longitude), radiusM: draft!.radius }
    : selected && selected.latitude != null && selected.longitude != null
      ? { lat: selected.latitude, lng: selected.longitude, radiusM: selected.geofence_radius_m }
      : undefined;

  const center: [number, number] = focus ? [focus.lat, focus.lng] : pins.length ? [pins[0].lat, pins[0].lng] : [37.0, -120.0];

  function useMyLocation() {
    if (!("geolocation" in navigator) || !draft) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setDraft((d) => d && { ...d, latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (e) => setErr(e.message),
      { enableHighAccuracy: true },
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <LeafletMap
          center={center}
          zoom={focus ? 16 : pins.length ? 12 : 4}
          pins={draftHasPoint ? [...pins, { lat: Number(draft!.latitude), lng: Number(draft!.longitude), label: draft!.name || t("New location") }] : pins}
          circle={focus}
          height={460}
          onClick={(lat, lng) => { if (draft) setDraft({ ...draft, latitude: lat, longitude: lng }); }}
        />
        <div className="border-t border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {draft ? t("Click the map to place this location's pin.") : t("Select or add a location to place its pin.")}
          {" "}{t("Map data © OpenStreetMap contributors — rendered with Leaflet.")}
        </div>
      </div>

      <Panel
        title={t("Locations")}
        subtitle={t("Each site can carry its own geofence radius.")}
        action={
          <Button size="sm" onClick={() => { setErr(null); setSelectedId(null); setDraft({ name: "", address: "", latitude: "", longitude: "", radius: 200, isActive: true }); }}>
            <Plus className="mr-2 h-4 w-4" />{t("Add")}
          </Button>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="loc-name">{t("Name")}</Label>
              <Input id="loc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("e.g. North Yard")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-addr">{t("Address")}</Label>
              <Input id="loc-addr" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("Latitude")}</Label>
                <Input type="number" step="any" value={draft.latitude}
                  onChange={(e) => setDraft({ ...draft, latitude: e.target.value === "" ? "" : Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("Longitude")}</Label>
                <Input type="number" step="any" value={draft.longitude}
                  onChange={(e) => setDraft({ ...draft, longitude: e.target.value === "" ? "" : Number(e.target.value) })} />
              </div>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={useMyLocation}>
              <Crosshair className="mr-2 h-4 w-4" />{t("Use my current location")}
            </Button>
            <div>
              <Label className="text-xs">{t("Geofence radius:")} <span className="font-medium text-foreground">{draft.radius} m</span></Label>
              <input type="range" min={25} max={2000} step={25} value={draft.radius}
                onChange={(e) => setDraft({ ...draft, radius: Number(e.target.value) })} className="w-full" />
            </div>
            {!org.missing && (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/30 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{t("Active")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("Off: no one new can be given this location. People already there keep it, and old records still show it.")}
                  </div>
                </div>
                <Switch checked={draft.isActive} onCheckedChange={(v) => setDraft({ ...draft, isActive: v })} />
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setDraft(null); setErr(null); }}>{t("Cancel")}</Button>
              <Button className="flex-1" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("Save")}
              </Button>
            </div>
            <ErrorNote error={err} />
          </div>
        ) : q.isLoading ? <EmptyState>Loading…</EmptyState>
          : rows.length === 0 ? <EmptyState>{t("No locations yet.")}</EmptyState>
          : (
            <>
              <ul className="divide-y divide-border">
                {rows.map((l) => (
                  <li key={l.id}
                    className={`flex cursor-pointer items-center justify-between gap-3 py-3 ${selectedId === l.id ? "opacity-100" : ""}`}
                    onClick={() => setSelectedId(l.id)}>
                    <div className="min-w-0">
                      <p className={`flex items-center gap-2 truncate text-sm font-medium text-foreground ${isActive(l.id) ? "" : "opacity-60"}`}>
                        {l.name}
                        {!isActive(l.id) && <InactiveTag />}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {l.address || (l.latitude != null ? `${l.latitude.toFixed(4)}, ${l.longitude?.toFixed(4)}` : t("No pin set"))}
                        {" · "}{l.geofence_radius_m} m
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" aria-label={t("Edit {name}", { name: l.name })}
                        onClick={(e) => {
                          e.stopPropagation(); setErr(null);
                          setDraft({
                            id: l.id, name: l.name, address: l.address ?? "",
                            latitude: l.latitude ?? "", longitude: l.longitude ?? "", radius: l.geofence_radius_m,
                            isActive: isActive(l.id),
                          });
                        }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={t("Delete {name}", { name: l.name })}
                        onClick={(e) => { e.stopPropagation(); del.mutate(l.id); }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <ErrorNote error={err} />
            </>
          )}
      </Panel>
    </div>
  );
}
