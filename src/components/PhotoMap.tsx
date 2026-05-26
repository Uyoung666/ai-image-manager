import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Globe, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toLocalMediaUrl } from "@/utils/local-media-url";

export interface GeoLocation {
  filename: string | null;
  height: number | null;
  latitude: number;
  longitude: number;
  path: string;
  photoId: number;
  width: number | null;
}

const markerIcon = L.divIcon({
  className: "photo-map-marker",
  html: '<div class="marker-dot"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  popupAnchor: [0, -8],
});

function FitBounds({
  locations,
  maxZoom,
}: {
  locations: GeoLocation[];
  maxZoom: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (locations.length === 0) {
      return;
    }
    if (locations.length === 1) {
      map.setView(
        [locations[0].latitude, locations[0].longitude],
        Math.min(13, maxZoom)
      );
      return;
    }
    const bounds = L.latLngBounds(
      locations.map((l) => [l.latitude, l.longitude] as [number, number])
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom });
  }, [map, locations, maxZoom]);

  return null;
}

function GeoJsonLayer({ data }: { data: GeoJSON.GeoJSON | null }) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    if (!(data && map)) {
      return;
    }

    const layer = L.geoJSON(data, {
      style: {
        color: "#3d5068",
        weight: 0.8,
        fillColor: "#1e2632",
        fillOpacity: 1,
      },
      onEachFeature: (feature, l) => {
        const name = feature?.properties?.NAME;
        if (name) {
          l.bindTooltip(name, {
            permanent: false,
            direction: "center",
            className: "country-label-tooltip",
            opacity: 0.85,
          });
        }
      },
    }).addTo(map);
    layerRef.current = layer;

    return () => {
      layer.remove();
      layerRef.current = null;
    };
  }, [map, data]);

  return null;
}

export function PhotoMap({
  locations,
  mapSource,
  onMapSourceChange,
}: {
  locations: GeoLocation[];
  mapSource: "offline" | "online";
  onMapSourceChange: (source: "offline" | "online") => void;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [geoData, setGeoData] = useState<GeoJSON.GeoJSON | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (mapSource === "offline" && !geoData) {
      import("@/assets/ne_50m_admin_0_countries.json")
        .then((m) =>
          setGeoData(
            (m as unknown as { default: GeoJSON.GeoJSON }).default ||
              (m as unknown as GeoJSON.GeoJSON)
          )
        )
        .catch(() => {});
    }
  }, [mapSource, geoData]);

  if (locations.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-[8px] border border-border bg-secondary">
        <p className="text-[13px] text-muted-foreground/70">{t("noGeoData")}</p>
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
    <div className="photo-map-wrapper relative overflow-hidden rounded-[8px] border border-border">
      <MapContainer
        attributionControl={true}
        center={center}
        className="h-[380px] w-full"
        key={mapSource}
        zoom={5}
        zoomControl={false}
      >
        {mapSource === "online" ? (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
        ) : (
          <GeoJsonLayer data={geoData} />
        )}
        <FitBounds
          locations={locations}
          maxZoom={mapSource === "offline" ? 6 : 13}
        />
        {locations.map((loc) => (
          <Marker
            icon={markerIcon}
            key={loc.photoId}
            position={[loc.latitude, loc.longitude]}
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
                {loc.width && loc.height && (
                  <p className="text-[10px] text-muted-foreground/70">
                    {loc.width} × {loc.height}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground/70">
                  {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                </p>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      <button
        className="absolute top-2 right-2 z-[1000] flex items-center gap-1.5 rounded-[6px] border border-border bg-secondary/90 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:bg-secondary hover:text-foreground"
        onClick={() =>
          onMapSourceChange(mapSource === "offline" ? "online" : "offline")
        }
        title={
          mapSource === "offline"
            ? t("mapSwitchToOnline")
            : t("mapSwitchToOffline")
        }
      >
        {mapSource === "offline" ? (
          <>
            <Globe className="h-3.5 w-3.5" />
            <span>{t("mapModeOnline")}</span>
          </>
        ) : (
          <>
            <WifiOff className="h-3.5 w-3.5" />
            <span>{t("mapModeOffline")}</span>
          </>
        )}
      </button>
    </div>
  );
}
