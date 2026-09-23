"use client";
import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Itinerary } from "@/lib/types";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

export default function ItineraryMap({ itinerary }: { itinerary: Itinerary | null }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [0, 20],
      zoom: 1.5,
    });
  }, []);

  useEffect(() => {
    if (!map.current || !itinerary) return;

    const currentMap = map.current;

    const cleanupRoutes = () => {
      itinerary.days.forEach((day) => {
        const layerId = `route-layer-${day.day}`;
        const sourceId = `route-source-${day.day}`;
        if (currentMap.getLayer(layerId)) currentMap.removeLayer(layerId);
        if (currentMap.getSource(sourceId)) currentMap.removeSource(sourceId);
      });
    };

    document.querySelectorAll(".mapboxgl-marker").forEach((m) => m.remove());
    cleanupRoutes();

    const bounds = new mapboxgl.LngLatBounds();
    const colors = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"];

    // יצירת מרקרים לכל מקום
    itinerary.days.forEach((day, dayIdx) => {
      day.places.forEach((place, i) => {
        const el = document.createElement("div");
        el.className = "flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold shadow-lg border-2 border-white";
        el.style.backgroundColor = colors[dayIdx % colors.length];
        el.textContent = `${day.day}.${i + 1}`;

        new mapboxgl.Marker({ element: el })
          .setLngLat([place.lng, place.lat])
          .setPopup(
            new mapboxgl.Popup({ offset: 20 }).setHTML(
              `<div dir="rtl" style="text-align: right;"><strong>${place.name}</strong><p>${place.description}</p></div>`
            )
          )
          .addTo(currentMap);

        bounds.extend([place.lng, place.lat]);
      });
    });

    if (!bounds.isEmpty()) {
      currentMap.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    }

    // שליפה וציור של קווי הניווט (Directions API) על הכבישים
    itinerary.days.forEach(async (day, dayIdx) => {
      if (day.places.length < 2) return;

      const coordinates = day.places.map((place) => [place.lng, place.lat]);
      const coordsString = coordinates.map((c) => c.join(",")).join(";");
      const color = colors[dayIdx % colors.length];

      const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordsString}?geometries=geojson&access_token=${mapboxgl.accessToken}`;

      try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.routes && data.routes[0] && currentMap) {
          const routeGeometry = data.routes[0].geometry;
          const sourceId = `route-source-${day.day}`;
          const layerId = `route-layer-${day.day}`;

          if (!currentMap.getSource(sourceId)) {
            currentMap.addSource(sourceId, {
              type: "geojson",
              data: {
                type: "Feature",
                properties: {},
                geometry: routeGeometry,
              },
            });

            currentMap.addLayer({
              id: layerId,
              type: "line",
              source: sourceId,
              layout: {
                "line-join": "round",
                "line-cap": "round",
              },
              paint: {
                "line-color": color,
                "line-width": 4,
                "line-opacity": 0.85,
              },
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching route for day ${day.day}:`, error);
      }
    });

    return () => {
      cleanupRoutes();
    };
  }, [itinerary]);

  return <div ref={mapContainer} className="w-full h-full rounded-xl" />;
}