import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LeafletMap } from "@/components/leaflet-map";
import { MapPin, Crosshair, Save, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/worksite")({
  component: WorksitePage,
});

function WorksitePage() {
  const { company, primaryRole, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [lat, setLat] = useState<number | "">("");
  const [lng, setLng] = useState<number | "">("");
  const [radius, setRadius] = useState<number>(200);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && primaryRole && primaryRole !== "company_admin" && primaryRole !== "super_admin") {
      navigate({ to: "/dashboard" });
    }
  }, [loading, primaryRole, navigate]);

  const q = useQuery({
    queryKey: ["worksite", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("id, name, latitude, longitude, geofence_radius_m")
        .eq("id", company!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (q.data) {
      if (q.data.latitude != null) setLat(q.data.latitude);
      if (q.data.longitude != null) setLng(q.data.longitude);
      if (q.data.geofence_radius_m) setRadius(q.data.geofence_radius_m);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (lat === "" || lng === "") throw new Error("Pick a location on the map first.");
      const { error } = await supabase.rpc("set_company_location", {
        _lat: Number(lat),
        _lng: Number(lng),
        _radius: Number(radius),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMsg("Saved.");
      qc.invalidateQueries({ queryKey: ["worksite"] });
      qc.invalidateQueries({ queryKey: ["timeclock-company"] });
    },
    onError: (e: any) => setMsg(e.message || "Failed to save"),
  });

  function useMyLocation() {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLat(pos.coords.latitude); setLng(pos.coords.longitude); },
      (err) => setMsg(err.message),
      { enableHighAccuracy: true },
    );
  }

  const hasPoint = lat !== "" && lng !== "";
  const center: [number, number] = hasPoint ? [Number(lat), Number(lng)] : [37.0, -120.0];

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!company) return <div className="text-sm text-muted-foreground">No company.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Worksite location</h1>
        <p className="text-sm text-muted-foreground">
          Click the map to set where employees must be in order to clock in/out. The blue circle shows the allowed area.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <LeafletMap
            center={center}
            zoom={hasPoint ? 16 : 5}
            pins={hasPoint ? [{ lat: Number(lat), lng: Number(lng), label: "Worksite" }] : []}
            circle={hasPoint ? { lat: Number(lat), lng: Number(lng), radiusM: radius } : undefined}
            height={420}
            onClick={(la, ln) => { setLat(la); setLng(ln); }}
          />
          <div className="border-t border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Click anywhere on the map to drop the pin. Map data © OpenStreetMap contributors.
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <MapPin className="h-4 w-4 text-primary" /> Coordinates
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Latitude</Label>
              <Input value={lat} onChange={(e) => setLat(e.target.value === "" ? "" : Number(e.target.value))} type="number" step="any" />
            </div>
            <div>
              <Label className="text-xs">Longitude</Label>
              <Input value={lng} onChange={(e) => setLng(e.target.value === "" ? "" : Number(e.target.value))} type="number" step="any" />
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={useMyLocation} className="w-full">
            <Crosshair className="mr-2 h-4 w-4" />Use my current location
          </Button>

          <div>
            <Label className="text-xs">Allowed radius: <span className="font-medium text-foreground">{radius} m</span></Label>
            <input
              type="range" min={25} max={2000} step={25}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>25 m</span><span>2000 m</span>
            </div>
          </div>

          <Button onClick={() => { setMsg(null); save.mutate(); }} disabled={save.isPending || !hasPoint} className="w-full">
            {save.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : <><Save className="mr-2 h-4 w-4" />Save worksite</>}
          </Button>
          {msg && <p className="text-center text-xs text-muted-foreground">{msg}</p>}

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <p className="mb-1 font-medium text-foreground">Currently saved</p>
            {q.data?.latitude != null && q.data?.longitude != null ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
                <dt>Latitude</dt><dd className="font-mono text-foreground">{q.data.latitude.toFixed(6)}</dd>
                <dt>Longitude</dt><dd className="font-mono text-foreground">{q.data.longitude.toFixed(6)}</dd>
                <dt>Radius</dt><dd className="font-mono text-foreground">{q.data.geofence_radius_m} m</dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">No worksite saved yet — drop a pin and click Save.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
