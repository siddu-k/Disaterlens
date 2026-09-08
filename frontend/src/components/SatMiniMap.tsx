import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { BoundingBox, SatChange, SatDetection } from '../types';

// Lightweight standalone map for the Satellite Vision page only.
// Shows the AOI box, detection markers and change highlights — no simulation logic.
const TYPE_COLORS: Record<string, string> = {
  building: '#38bdf8',
  road: '#34d399',
  water: '#60a5fa',
  tree: '#4ade80',
  solar: '#facc15',
};

interface SatMiniMapProps {
  bbox: BoundingBox | null;
  detections: SatDetection[] | null;
  changes: SatChange[] | null;
  layersVisible: boolean;
  compareMix: number;
  focusedPoint: { lat: number; lon: number; nonce: number } | null;
  drawMode?: boolean;
  onBboxSelect?: (bbox: BoundingBox) => void;
}

export default function SatMiniMap({
  bbox,
  detections,
  changes,
  layersVisible,
  compareMix,
  focusedPoint,
  drawMode = false,
  onBboxSelect,
}: SatMiniMapProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const boxRef = useRef<L.LayerGroup | null>(null);
  const detRef = useRef<L.LayerGroup | null>(null);
  const chRef = useRef<L.LayerGroup | null>(null);
  const drawModeRef = useRef(drawMode);
  const onBboxSelectRef = useRef(onBboxSelect);
  const drawStartRef = useRef<L.LatLng | null>(null);
  const tempRectRef = useRef<L.Rectangle | null>(null);

  useEffect(() => {
    drawModeRef.current = drawMode;
    onBboxSelectRef.current = onBboxSelect;
  }, [drawMode, onBboxSelect]);

  useEffect(() => {
    if (!divRef.current || mapRef.current) return;
    const map = L.map(divRef.current, {
      center: [20.0, 10.0],
      zoom: 2,
      attributionControl: false,
    });
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 }
    ).addTo(map);
    boxRef.current = L.layerGroup().addTo(map);
    detRef.current = L.layerGroup().addTo(map);
    chRef.current = L.layerGroup().addTo(map);

    // Drag-box AOI drawing (same interaction as the main map)
    const clearTemp = () => {
      if (tempRectRef.current) {
        map.removeLayer(tempRectRef.current);
        tempRectRef.current = null;
      }
      drawStartRef.current = null;
      map.dragging.enable();
      map.getContainer().style.cursor = '';
    };
    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (!drawModeRef.current) return;
      drawStartRef.current = e.latlng;
      map.dragging.disable();
      map.getContainer().style.cursor = 'crosshair';
      tempRectRef.current = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
        color: '#38bdf8',
        weight: 2,
        dashArray: '5, 5',
        fillColor: '#38bdf8',
        fillOpacity: 0.15,
      }).addTo(map);
    };
    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (!drawModeRef.current || !drawStartRef.current || !tempRectRef.current) return;
      tempRectRef.current.setBounds(L.latLngBounds(drawStartRef.current, e.latlng));
    };
    const onMouseUp = (e: L.LeafletMouseEvent) => {
      if (!drawModeRef.current || !drawStartRef.current) return;
      const bounds = L.latLngBounds(drawStartRef.current, e.latlng);
      const south = Math.min(bounds.getSouth(), bounds.getNorth());
      const north = Math.max(bounds.getSouth(), bounds.getNorth());
      const west = Math.min(bounds.getWest(), bounds.getEast());
      const east = Math.max(bounds.getWest(), bounds.getEast());
      const wasValid = north - south > 0.002 && east - west > 0.002;
      const out = { south, north, west, east };
      clearTemp();
      if (wasValid) onBboxSelectRef.current?.(out);
    };
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    mapRef.current = map;
    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Draw-mode cursor + panning toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || drawStartRef.current) return;
    if (drawMode) {
      map.dragging.disable();
      map.getContainer().style.cursor = 'crosshair';
    } else {
      map.dragging.enable();
      map.getContainer().style.cursor = '';
    }
  }, [drawMode]);

  // AOI box
  useEffect(() => {
    if (!mapRef.current || !boxRef.current) return;
    boxRef.current.clearLayers();
    if (!bbox) return;
    const bounds: L.LatLngBoundsExpression = [
      [bbox.south, bbox.west],
      [bbox.north, bbox.east],
    ];
    L.rectangle(bounds, {
      color: '#38bdf8',
      weight: 2,
      dashArray: '6, 4',
      fillColor: '#38bdf8',
      fillOpacity: 0.05,
    }).addTo(boxRef.current);
    mapRef.current.fitBounds(bounds, { padding: [30, 30] });
  }, [bbox]);

  // Detections + changes
  useEffect(() => {
    if (!detRef.current || !chRef.current) return;
    detRef.current.clearLayers();
    chRef.current.clearLayers();
    if (!layersVisible) return;
    const mix = Math.min(Math.max(compareMix ?? 0.5, 0), 1);
    const detOpacity = changes && changes.length > 0 ? 1 - mix : 1;

    (detections || []).slice(0, 1000).forEach((d) => {
      if (typeof d.lat !== 'number' || typeof d.lon !== 'number') return;
      const color = TYPE_COLORS[d.type] || '#94a3b8';
      L.circleMarker([d.lat, d.lon], {
        radius: 4,
        color,
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.85 * detOpacity + 0.15,
        opacity: detOpacity,
      })
        .addTo(detRef.current!)
        .bindTooltip(
          `<b>${d.type}</b>${d.confidence != null ? ` • ${Math.round(d.confidence * 100)}%` : ''}${d.area_sqm != null ? `<br/>${Math.round(d.area_sqm)} m²` : ''}`,
          { direction: 'top', className: 'custom-map-tooltip' }
        );
    });

    (changes || []).slice(0, 500).forEach((c) => {
      if (typeof c.lat !== 'number' || typeof c.lon !== 'number') return;
      const color = c.change === 'added' ? '#22c55e' : c.change === 'removed' ? '#ef4444' : '#f59e0b';
      L.circleMarker([c.lat, c.lon], {
        radius: 6,
        color: '#ffffff',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.9,
      })
        .addTo(chRef.current!)
        .bindTooltip(`<b>${c.change}</b> • ${c.type}`, {
          direction: 'top',
          className: 'custom-map-tooltip',
        });
    });
  }, [detections, changes, layersVisible, compareMix]);

  // Click-to-locate from lists
  useEffect(() => {
    if (!focusedPoint || !mapRef.current) return;
    if (typeof focusedPoint.lat !== 'number' || typeof focusedPoint.lon !== 'number') return;
    mapRef.current.flyTo([focusedPoint.lat, focusedPoint.lon], Math.max(mapRef.current.getZoom(), 15), {
      duration: 0.8,
    });
  }, [focusedPoint]);

  return <div ref={divRef} className="satminimap" role="application" aria-label="Satellite vision preview map" />;
}
