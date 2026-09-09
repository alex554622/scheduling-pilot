import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { Building2, MapPin, BriefcaseBusiness, LayoutTemplate, Plus, Trash2, Pencil, Loader2, Crosshair, Globe } from "lucide-react";

export const Route = createFileRoute("/_authenticated/organization")({
  component: OrganizationPage,
});

type Department = { id: string; name: string; description: string | null };
type Position = { id: string; name: string; description: string | null; color: string };
type Location = {
  id: string; name: string; address: string | null;
  latitude: number | null; longitude: number | null; geofence_radius_m: number;
};
type Template = {
  id: string; name: string; start_time: string; end_time: string;
  break_minutes: number; required_headcount: number;
  department_id: string | null; location_id: string | null; position_id: string | null;
};

function OrganizationPage() {
  const { company, primaryRole, loading } = useAuth();
  const navigate = useNavigate();

  // Company admins own the org structure (matches the RLS policies).
  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">Join a company first.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Organization</h1>
        <p className="text-sm text-muted-foreground">
          Departments, job positions, worksites, and reusable shift templates for {company.name}.
        </p>
      </div>

      <Tabs defaultValue="general">
        <TabsList className="flex-wrap">
          <TabsTrigger value="general"><Globe className="mr-2 h-4 w-4" />General</TabsTrigger>
          <TabsTrigger value="departments"><Building2 className="mr-2 h-4 w-4" />Departments</TabsTrigger>
          <TabsTrigger value="positions"><BriefcaseBusiness className="mr-2 h-4 w-4" />Positions</TabsTrigger>
          <TabsTrigger value="locations"><MapPin className="mr-2 h-4 w-4" />Locations</TabsTrigger>
          <TabsTrigger value="templates"><LayoutTemplate className="mr-2 h-4 w-4" />Shift templates</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6"><GeneralTab companyId={company.id} /></TabsContent>
        <TabsContent value="departments" className="mt-6"><DepartmentsTab companyId={company.id} /></TabsContent>
        <TabsContent value="positions" className="mt-6"><PositionsTab companyId={company.id} /></TabsContent>
        <TabsContent value="locations" className="mt-6"><LocationsTab companyId={company.id} /></TabsContent>
        <TabsContent value="templates" className="mt-6"><TemplatesTab companyId={company.id} /></TabsContent>
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
    <Panel title="Scheduling timezone" subtitle="Used to match shifts against stated availability and weekly hour totals.">
      <div className="max-w-md space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tz">Timezone</Label>
          <select
            id="tz"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={value}
            onChange={(e) => setTz(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>{z}{z === detected ? "  (this device)" : ""}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            This device reports <span className="font-medium text-foreground">{detected}</span>.
            Leaving this on UTC while your team works in another zone makes ordinary day shifts
            look like they cross midnight.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button disabled={save.isPending || value === q.data} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save timezone
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
        <ErrorNote error={err} />
      </div>
    </Panel>
  );
}

/* ------------------------------- departments ------------------------------- */

function DepartmentsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
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

  const save = useMutation({
    mutationFn: async (v: { id?: string; name: string; description: string }) => {
      if (v.id) {
        const { error } = await supabase.from("departments")
          .update({ name: v.name, description: v.description || null }).eq("id", v.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("departments")
          .insert({ company_id: companyId, name: v.name, description: v.description || null });
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["departments"] }); setEditing(null); setCreating(false); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("departments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const rows = q.data ?? [];

  return (
    <Panel
      title="Departments"
      subtitle="Group employees and shifts by team."
      action={<Button size="sm" onClick={() => { setErr(null); setCreating(true); }}><Plus className="mr-2 h-4 w-4" />Add department</Button>}
    >
      {q.isLoading ? <EmptyState>Loading…</EmptyState>
        : rows.length === 0 ? <EmptyState>No departments yet.</EmptyState>
        : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{d.name}</p>
                  {d.description && <p className="truncate text-xs text-muted-foreground">{d.description}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setErr(null); setEditing(d); }} aria-label={`Edit ${d.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => del.mutate(d.id)} aria-label={`Delete ${d.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <ErrorNote error={err} />

      <NameDescDialog
        open={creating || !!editing}
        title={editing ? "Edit department" : "New department"}
        initial={editing ? { name: editing.name, description: editing.description ?? "" } : { name: "", description: "" }}
        pending={save.isPending}
        onCancel={() => { setCreating(false); setEditing(null); }}
        onSave={(v) => save.mutate({ id: editing?.id, ...v })}
      />
    </Panel>
  );
}

function NameDescDialog({ open, title, initial, pending, onCancel, onSave }: {
  open: boolean; title: string; initial: { name: string; description: string };
  pending: boolean; onCancel: () => void; onSave: (v: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);

  // Re-seed the form whenever a different row opens the dialog.
  useEffect(() => { setName(initial.name); setDescription(initial.description); }, [initial.name, initial.description, open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="nd-name">Name</Label>
            <Input id="nd-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front of House" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nd-desc">Description</Label>
            <Textarea id="nd-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={!name.trim() || pending} onClick={() => onSave({ name: name.trim(), description })}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- positions -------------------------------- */

function PositionsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
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

  const save = useMutation({
    mutationFn: async (v: { id?: string; name: string; description: string }) => {
      if (v.id) {
        const { error } = await supabase.from("positions")
          .update({ name: v.name, description: v.description || null }).eq("id", v.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("positions")
          .insert({ company_id: companyId, name: v.name, description: v.description || null });
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["positions"] }); setEditing(null); setCreating(false); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("positions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["positions"] }),
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const rows = q.data ?? [];

  return (
    <Panel
      title="Job positions"
      subtitle="Roles employees can be qualified for. The scheduler warns when someone isn't qualified."
      action={<Button size="sm" onClick={() => { setErr(null); setCreating(true); }}><Plus className="mr-2 h-4 w-4" />Add position</Button>}
    >
      {q.isLoading ? <EmptyState>Loading…</EmptyState>
        : rows.length === 0 ? <EmptyState>No positions yet.</EmptyState>
        : (
          <ul className="divide-y divide-border">
            {rows.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                  {p.description && <p className="truncate text-xs text-muted-foreground">{p.description}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setErr(null); setEditing(p); }} aria-label={`Edit ${p.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => del.mutate(p.id)} aria-label={`Delete ${p.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <ErrorNote error={err} />

      <NameDescDialog
        open={creating || !!editing}
        title={editing ? "Edit position" : "New position"}
        initial={editing ? { name: editing.name, description: editing.description ?? "" } : { name: "", description: "" }}
        pending={save.isPending}
        onCancel={() => { setCreating(false); setEditing(null); }}
        onSave={(v) => save.mutate({ id: editing?.id, ...v })}
      />
    </Panel>
  );
}

/* -------------------------------- locations -------------------------------- */

function LocationsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    id?: string; name: string; address: string;
    latitude: number | ""; longitude: number | ""; radius: number;
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
      if (!draft.name.trim()) throw new Error("Give the location a name.");
      const payload = {
        name: draft.name.trim(),
        address: draft.address || null,
        latitude: draft.latitude === "" ? null : Number(draft.latitude),
        longitude: draft.longitude === "" ? null : Number(draft.longitude),
        geofence_radius_m: draft.radius,
      };
      if (draft.id) {
        const { error } = await supabase.from("locations").update(payload).eq("id", draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("locations").insert({ company_id: companyId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["locations"] }); setDraft(null); setErr(null); },
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
          pins={draftHasPoint ? [...pins, { lat: Number(draft!.latitude), lng: Number(draft!.longitude), label: draft!.name || "New location" }] : pins}
          circle={focus}
          height={460}
          onClick={(lat, lng) => { if (draft) setDraft({ ...draft, latitude: lat, longitude: lng }); }}
        />
        <div className="border-t border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {draft ? "Click the map to place this location's pin." : "Select or add a location to place its pin."}
          {" "}Map data © OpenStreetMap contributors — rendered with Leaflet.
        </div>
      </div>

      <Panel
        title="Locations"
        subtitle="Each site can carry its own geofence radius."
        action={
          <Button size="sm" onClick={() => { setErr(null); setSelectedId(null); setDraft({ name: "", address: "", latitude: "", longitude: "", radius: 200 }); }}>
            <Plus className="mr-2 h-4 w-4" />Add
          </Button>
        }
      >
        {draft ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="loc-name">Name</Label>
              <Input id="loc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. North Yard" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-addr">Address</Label>
              <Input id="loc-addr" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Latitude</Label>
                <Input type="number" step="any" value={draft.latitude}
                  onChange={(e) => setDraft({ ...draft, latitude: e.target.value === "" ? "" : Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Longitude</Label>
                <Input type="number" step="any" value={draft.longitude}
                  onChange={(e) => setDraft({ ...draft, longitude: e.target.value === "" ? "" : Number(e.target.value) })} />
              </div>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={useMyLocation}>
              <Crosshair className="mr-2 h-4 w-4" />Use my current location
            </Button>
            <div>
              <Label className="text-xs">Geofence radius: <span className="font-medium text-foreground">{draft.radius} m</span></Label>
              <input type="range" min={25} max={2000} step={25} value={draft.radius}
                onChange={(e) => setDraft({ ...draft, radius: Number(e.target.value) })} className="w-full" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setDraft(null); setErr(null); }}>Cancel</Button>
              <Button className="flex-1" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
              </Button>
            </div>
            <ErrorNote error={err} />
          </div>
        ) : q.isLoading ? <EmptyState>Loading…</EmptyState>
          : rows.length === 0 ? <EmptyState>No locations yet.</EmptyState>
          : (
            <>
              <ul className="divide-y divide-border">
                {rows.map((l) => (
                  <li key={l.id}
                    className={`flex cursor-pointer items-center justify-between gap-3 py-3 ${selectedId === l.id ? "opacity-100" : ""}`}
                    onClick={() => setSelectedId(l.id)}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{l.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {l.address || (l.latitude != null ? `${l.latitude.toFixed(4)}, ${l.longitude?.toFixed(4)}` : "No pin set")}
                        {" · "}{l.geofence_radius_m} m
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" aria-label={`Edit ${l.name}`}
                        onClick={(e) => {
                          e.stopPropagation(); setErr(null);
                          setDraft({
                            id: l.id, name: l.name, address: l.address ?? "",
                            latitude: l.latitude ?? "", longitude: l.longitude ?? "", radius: l.geofence_radius_m,
                          });
                        }}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Delete ${l.name}`}
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

/* -------------------------------- templates -------------------------------- */

function TemplatesTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<Template> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ["shift_templates", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_templates")
        .select("id, name, start_time, end_time, break_minutes, required_headcount, department_id, location_id, position_id")
        .eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as Template[];
    },
  });

  const positionsQ = useQuery({
    queryKey: ["positions", companyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("positions").select("id, name").eq("company_id", companyId).order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!draft?.name?.trim()) throw new Error("Give the template a name.");
      const payload = {
        name: draft.name.trim(),
        start_time: draft.start_time || "09:00",
        end_time: draft.end_time || "17:00",
        break_minutes: draft.break_minutes ?? 0,
        required_headcount: draft.required_headcount ?? 1,
        position_id: draft.position_id || null,
      };
      if (draft.id) {
        const { error } = await supabase.from("shift_templates").update(payload).eq("id", draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("shift_templates").insert({ company_id: companyId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["shift_templates"] }); setDraft(null); setErr(null); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("shift_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shift_templates"] }),
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
  });

  const rows = templatesQ.data ?? [];
  const positions = positionsQ.data ?? [];
  const posName = (id: string | null | undefined) => positions.find((p) => p.id === id)?.name;

  return (
    <Panel
      title="Shift templates"
      subtitle="Reusable start/end times you can apply when building a schedule."
      action={
        <Button size="sm" onClick={() => { setErr(null); setDraft({ name: "", start_time: "09:00", end_time: "17:00", break_minutes: 30, required_headcount: 1 }); }}>
          <Plus className="mr-2 h-4 w-4" />Add template
        </Button>
      }
    >
      {templatesQ.isLoading ? <EmptyState>Loading…</EmptyState>
        : rows.length === 0 ? <EmptyState>No templates yet.</EmptyState>
        : (
          <ul className="divide-y divide-border">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{t.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)}
                    {t.break_minutes ? ` · ${t.break_minutes}m break` : ""}
                    {t.required_headcount > 1 ? ` · needs ${t.required_headcount}` : ""}
                    {posName(t.position_id) ? ` · ${posName(t.position_id)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => { setErr(null); setDraft(t); }} aria-label={`Edit ${t.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => del.mutate(t.id)} aria-label={`Delete ${t.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <ErrorNote error={err} />

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit template" : "New shift template"}</DialogTitle>
            <DialogDescription>Times are the site's local wall-clock times.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input id="tpl-name" value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Day Shift" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-start">Starts</Label>
                  <Input id="tpl-start" type="time" value={(draft.start_time ?? "09:00").slice(0, 5)}
                    onChange={(e) => setDraft({ ...draft, start_time: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-end">Ends</Label>
                  <Input id="tpl-end" type="time" value={(draft.end_time ?? "17:00").slice(0, 5)}
                    onChange={(e) => setDraft({ ...draft, end_time: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-break">Break (minutes)</Label>
                  <Input id="tpl-break" type="number" min={0} value={draft.break_minutes ?? 0}
                    onChange={(e) => setDraft({ ...draft, break_minutes: Number(e.target.value) })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-head">People needed</Label>
                  <Input id="tpl-head" type="number" min={1} value={draft.required_headcount ?? 1}
                    onChange={(e) => setDraft({ ...draft, required_headcount: Number(e.target.value) })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-pos">Position</Label>
                <select id="tpl-pos"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  value={draft.position_id ?? ""}
                  onChange={(e) => setDraft({ ...draft, position_id: e.target.value || null })}>
                  <option value="">— none —</option>
                  {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
