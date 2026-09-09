import { useEffect, useRef, useState } from "react";

type LeafletMapInstance = {
  remove: () => void;
  setView: (center: [number, number], zoom: number) => void;
  on: (event: "click", handler: (e: { latlng: { lat: number; lng: number } }) => void) => void;
};

type LeafletLayerGroup = {
  clearLayers: () => void;
};

type LeafletModule = typeof import("leaflet");

export type LeafletPin = {
  lat: number;
  lng: number;
  label?: string;
};

interface Props {
  center: [number, number];
  zoom?: number;
  pins?: LeafletPin[];
  circle?: { lat: number; lng: number; radiusM: number };
  height?: number | string;
  onClick?: (lat: number, lng: number) => void;
  className?: string;
}

export function LeafletMap({ center, zoom = 15, pins = [], circle, height = 320, onClick, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMapInstance | null>(null);
  const layerRef = useRef<LeafletLayerGroup | null>(null);
  const onClickRef = useRef(onClick);
  const [ready, setReady] = useState(false);
  onClickRef.current = onClick;

  // Init map (client-only via dynamic import — Leaflet touches `window` at module scope)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default as LeafletModule;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !ref.current || mapRef.current) return;

      const DefaultIcon = L.icon({
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41],
      });
      L.Marker.prototype.options.icon = DefaultIcon;

      const map = L.map(ref.current, { zoomControl: true }).setView(center, zoom);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        onClickRef.current?.(e.latlng.lat, e.latlng.lng);
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update view
  useEffect(() => {
    if (mapRef.current && ready) mapRef.current.setView(center, zoom);
  }, [center[0], center[1], zoom, ready]);

  // Update markers/circle
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default as LeafletModule;
      if (cancelled) return;
      const layer = layerRef.current;
      if (!layer) return;
      layer.clearLayers();
      if (circle) {
        L.circle([circle.lat, circle.lng], {
          radius: circle.radiusM,
          color: "#2563eb",
          fillColor: "#3b82f6",
          fillOpacity: 0.12,
          weight: 2,
        }).addTo(layer as Parameters<ReturnType<LeafletModule["circle"]>["addTo"]>[0]);
      }
      for (const p of pins) {
        const m = L.marker([p.lat, p.lng]).addTo(layer as Parameters<ReturnType<LeafletModule["marker"]>["addTo"]>[0]);
        if (p.label) m.bindPopup(p.label);
      }
    })();
    return () => { cancelled = true; };
  }, [JSON.stringify(pins), circle?.lat, circle?.lng, circle?.radiusM, ready]);

  return <div ref={ref} className={className} style={{ height, width: "100%", borderRadius: 12, overflow: "hidden" }} />;
}
