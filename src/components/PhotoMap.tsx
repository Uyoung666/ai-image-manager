import { useEffect, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useTranslation } from "react-i18next";

export interface GeoLocation {
  photoId: number;
  latitude: number;
  longitude: number;
  filename: string | null;
  path: string;
  width: number | null;
  height: number | null;
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

const markerIcon = L.divIcon({
  className: "photo-map-marker",
  html: '<div class="marker-dot"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  popupAnchor: [0, -8],
});

function FitBounds({ locations }: { locations: GeoLocation[] }) {
  const map = useMap();

  useEffect(() => {
    if (locations.length === 0) return;
    if (locations.length === 1) {
      map.setView([locations[0].latitude, locations[0].longitude], 13);
      return;
    }
    const bounds = L.latLngBounds(
      locations.map((l) => [l.latitude, l.longitude] as [number, number])
    );
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, locations]);

  return null;
}

export function PhotoMap({ locations }: { locations: GeoLocation[] }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Defer map init so the container is in the DOM
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (locations.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-[8px] border border-border bg-secondary">
        <p className="text-muted-foreground/70 text-[13px]">{t("noGeoData")}</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="h-[320px] rounded-[8px] border border-border bg-secondary" />
    );
  }

  const center: [number, number] =
    locations.length === 1
      ? [locations[0].latitude, locations[0].longitude]
      : [30, 104];

  return (
    <div className="photo-map-wrapper overflow-hidden rounded-[8px] border border-border">
      <MapContainer
        center={center}
        zoom={5}
        className="h-[380px] w-full"
        zoomControl={false}
        attributionControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <FitBounds locations={locations} />
        {locations.map((loc) => (
          <Marker
            key={loc.photoId}
            position={[loc.latitude, loc.longitude]}
            icon={markerIcon}
          >
            <Popup>
              <div className="min-w-[160px]">
                {loc.path && (
                  <img
                    alt={loc.filename || ""}
                    className="mb-2 h-auto w-full rounded-[4px]"
                    src={toLocalMediaUrl(loc.path)}
                  />
                )}
                <p className="font-[510] text-[12px] text-foreground">
                  {loc.filename || "—"}
                </p>
                {(loc.width && loc.height) && (
                  <p className="text-muted-foreground/70 text-[10px]">
                    {loc.width} × {loc.height}
                  </p>
                )}
                <p className="text-muted-foreground/70 text-[10px]">
                  {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                </p>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
