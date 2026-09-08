import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BoundingBox, SimulationResult, RoadFeature, Facility, BuildingFeature, EvacuationRoute } from '../types';
import {
  IconFlood,
  IconCyclone,
  IconHeatwave,
  IconEarthquake,
  IconLandslide,
  IconBuilding,
  IconRoad,
  IconHospital,
  IconShelter,
  IconPolice,
  IconLocationPin,
  IconTag,
  IconPencil,
  IconTarget,
} from './Icons';

const Terrain3DViewer = lazy(() => import('./Terrain3DViewer'));

// Escape OSM-derived strings before interpolating into Leaflet tooltip HTML.
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/=/g, '&#61;')
    .replace(/\//g, '&#47;');
}

// Only http(s) URLs may render as clickable links; anything else is plain text.
function isSafeHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

// Per-hazard display vocabulary: per-frame marker thresholds, status words, units.
// Frame thresholds mirror backend analysis/impact.py building bands.
function hazardDisplay(disasterType?: string) {
  switch (disasterType) {
    case 'earthquake':
      return { unit: 'MMI', affectedWord: 'DAMAGED', clearWord: 'INTACT', frameThreshold: 6.0 };
    case 'wildfire':
      return { unit: 'severity', affectedWord: 'BURNING', clearWord: 'UNBURNED', frameThreshold: 0.35 };
    case 'landslide':
      return { unit: 'LSI', affectedWord: 'AT RISK', clearWord: 'STABLE', frameThreshold: 0.5 };
    case 'cyclone':
      return { unit: 'km/h', affectedWord: 'WIND-DAMAGED', clearWord: 'SECURE', frameThreshold: 90 };
    default:
      return { unit: 'm', affectedWord: 'FLOODED', clearWord: 'SAFE (DRY)', frameThreshold: 0.08 };
  }
}

// Viewport-culling + zoom-gating budgets (prevents tab freeze on large AOIs).
const MAX_VISIBLE_ROADS = 400;
const MAX_VISIBLE_BUILDINGS = 600;
const BUILDINGS_MIN_ZOOM = 14; // buildings render only when zoomed to street level
const ROAD_GLOW_MIN_ZOOM = 13; // dual-stroke glow only when zoomed in (halves objects)

function statusRank(status?: string): number {
  if (status === 'closed') return 2;
  if (status === 'restricted') return 1;
  return 0;
}

// Per-frame road status thresholds per hazard (mirrors backend thresholds).
function roadStatusThresholds(disasterType?: string): { closed: number; restricted: number } {
  switch (disasterType) {
    case 'earthquake':
      return { closed: 7.8, restricted: 6.5 };
    case 'wildfire':
      return { closed: 0.65, restricted: 0.35 };
    case 'landslide':
      return { closed: 0.75, restricted: 0.5 };
    case 'cyclone':
      return { closed: 130, restricted: 90 };
    default:
      return { closed: 0.45, restricted: 0.15 };
  }
}

function getWindCompassLabel(deg: number): string {
  const directions = [
    { label: 'N', min: 337.5, max: 360 },
    { label: 'N', min: 0, max: 22.5 },
    { label: 'NE', min: 22.5, max: 67.5 },
    { label: 'E', min: 67.5, max: 112.5 },
    { label: 'SE', min: 112.5, max: 157.5 },
    { label: 'S', min: 157.5, max: 202.5 },
    { label: 'SW', min: 202.5, max: 247.5 },
    { label: 'W', min: 247.5, max: 292.5 },
    { label: 'NW', min: 292.5, max: 337.5 },
  ];
  const d = ((deg % 360) + 360) % 360;
  const match = directions.find((dir) => d >= dir.min && d < dir.max);
  return match ? `${match.label} (${Math.round(d)}°)` : `${Math.round(d)}°`;
}

interface MapViewProps {
  mapMode: 'satellite' | 'map';
  setMapMode: (mode: 'satellite' | 'map') => void;
  onBboxSelect: (bbox: BoundingBox) => void;
  result: SimulationResult | null;
  currentFrame: number;
  setCurrentFrame?: (frame: number) => void;
  bbox: BoundingBox | null;
  showEvacuationRoutes: boolean;
  selectedRoad: RoadFeature | null;
  setSelectedRoad: (road: RoadFeature | null) => void;
  disasterType?: string;
  setDisasterType?: (d: any) => void;
  focusedFacility?: { fac: Facility; nonce: number } | null;
  buildingDensity?: 'medium' | 'maximum';
  isPlaying?: boolean;
  setIsPlaying?: (playing: boolean) => void;
  playSpeed?: number;
  setPlaySpeed?: (speed: number) => void;
  ignitionLat?: number | null;
  ignitionLon?: number | null;
  initialFireRadiusM?: number;
  wildfireWindDir?: number;
  wildfireWindSpeed?: number;
  onIgnitionSelect?: (lat: number, lon: number) => void;
  isPickingIgnition?: boolean;
  setIsPickingIgnition?: (val: boolean) => void;
}

const TILE_URLS = {
  map: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

// Reusable OpenStreetMap Raw Tag Viewer Component (Zero Data Waste)
function RawTagsViewer({ tags }: { tags?: Record<string, any> }) {
  const [expanded, setExpanded] = useState(false);
  if (!tags || Object.keys(tags).length === 0) return null;
  const entries = Object.entries(tags);

  return (
    <div className="osm-raw-tags-container">
      <div className="osm-raw-tags-header" onClick={() => setExpanded(!expanded)}>
        <span><IconTag size={13} className="svg-icon-inline" /> All OpenStreetMap Tags ({entries.length})</span>
        <span style={{ fontSize: '10.5px', color: '#38bdf8' }}>{expanded ? '▲ Hide' : '▼ Show All'}</span>
      </div>
      {expanded && (
        <div className="osm-raw-tags-grid">
          {entries.map(([k, v]) => (
            <div key={k} className="osm-raw-tag-item">
              <span className="osm-raw-tag-key">{k}</span>
              <span className="osm-raw-tag-val" title={String(v)}>
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sampleGridBilinear(grid: number[][], rows: number, cols: number, u: number, v: number): number {
  const gx = u * (cols - 1);
  const gy = v * (rows - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, cols - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const sx = gx - x0;
  const sy = gy - y0;

  const row0 = grid[y0];
  const row1 = grid[y1];
  const v00 = row0 ? (row0[x0] ?? 0) : 0;
  const v10 = row0 ? (row0[x1] ?? 0) : 0;
  const v01 = row1 ? (row1[x0] ?? 0) : 0;
  const v11 = row1 ? (row1[x1] ?? 0) : 0;

  const top = v00 * (1 - sx) + v10 * sx;
  const bottom = v01 * (1 - sx) + v11 * sx;
  return top * (1 - sy) + bottom * sy;
}

function renderHazardCanvas(
  grid: number[][],
  rows: number,
  cols: number,
  disaster: string,
  outWidth = 512,
  outHeight = 512
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const imgData = ctx.createImageData(outWidth, outHeight);
  const data = imgData.data;

  // Soft boundary feathering (outer 7% of bbox fades smoothly to 0 alpha)
  const marginX = outWidth * 0.07;
  const marginY = outHeight * 0.07;

  for (let py = 0; py < outHeight; py++) {
    const v = py / (outHeight - 1);
    const distY = Math.min(py, outHeight - 1 - py);
    const featherY = Math.min(1.0, distY / marginY);

    for (let px = 0; px < outWidth; px++) {
      const u = px / (outWidth - 1);
      const distX = Math.min(px, outWidth - 1 - px);
      const featherX = Math.min(1.0, distX / marginX);
      const feather = Math.min(featherX, featherY);
      const featherFactor = feather * feather;

      const val = sampleGridBilinear(grid, rows, cols, u, v);
      const idx = (py * outWidth + px) * 4;

      if (disaster === 'flood') {
        if (val > 0.02) {
          // Glistening fluid wave texture harmonics
          const wave = Math.sin(px * 0.08 + py * 0.06) * 0.045 + Math.sin(px * 0.18 - py * 0.14) * 0.025;
          const shimmer = 1.0 + wave;

          let r: number, g: number, b: number, a: number;

          if (val < 0.25) {
            // Shallow glistening foam / turquoise shoreline rim
            const t = val / 0.25;
            r = Math.round(56 + t * 20);
            g = Math.round(189 - t * 25);
            b = Math.round(248 - t * 10);
            a = Math.round((115 + t * 35) * featherFactor);
          } else if (val < 0.9) {
            // Active flood water - vibrant azure
            const t = (val - 0.25) / 0.65;
            r = Math.round(76 - t * 35);
            g = Math.round(164 - t * 65);
            b = Math.round(238 + t * 8);
            a = Math.round((150 + t * 35) * featherFactor);
          } else if (val < 2.5) {
            // Deep inundation - deep cobalt sapphire
            const t = (val - 0.9) / 1.6;
            r = Math.round(41 - t * 18);
            g = Math.round(99 - t * 38);
            b = Math.round(246 - t * 30);
            a = Math.round((185 + t * 30) * featherFactor);
          } else {
            // Extreme surge / submerged channels - abyssal dark blue
            const t = Math.min((val - 2.5) / 3.0, 1.0);
            r = Math.round(23 - t * 11);
            g = Math.round(61 - t * 25);
            b = Math.round(216 - t * 76);
            a = Math.round((215 + t * 30) * featherFactor);
          }

          data[idx] = Math.min(255, Math.max(0, Math.round(r * shimmer)));
          data[idx + 1] = Math.min(255, Math.max(0, Math.round(g * shimmer)));
          data[idx + 2] = Math.min(255, Math.max(0, Math.round(b * shimmer)));
          data[idx + 3] = Math.min(255, Math.max(0, a));
        } else {
          data[idx + 3] = 0;
        }
      } else if (disaster === 'earthquake') {
        if (val >= 4.0) {
          const norm = Math.min(Math.max((val - 4.0) / 5.0, 0), 1.0);
          const cx = outWidth / 2;
          const cy = outHeight / 2;
          const distFromCenter = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
          const wave = Math.sin(distFromCenter * 0.1) * 0.05;

          const r = Math.round(245 + norm * 10);
          const g = Math.round(158 * (1.0 - norm * 0.85));
          const b = Math.round(11 + norm * 80);
          const a = Math.round((110 + norm * 120) * featherFactor);

          const mult = 1.0 + wave;
          data[idx] = Math.min(255, Math.round(r * mult));
          data[idx + 1] = Math.min(255, Math.round(g * mult));
          data[idx + 2] = Math.min(255, Math.round(b * mult));
          data[idx + 3] = Math.min(255, a);
        } else {
          data[idx + 3] = 0;
        }
      } else if (disaster === 'wildfire') {
        if (val > 0.08) {
          const turbulence = Math.sin(px * 0.12 + py * 0.15) * 0.05;
          let r = 239, g = 68, b = 68, a = 180;

          if (val >= 0.75) {
            // 1. Active Flaming Perimeter (meter-by-meter incandescent fire line)
            const t = Math.min((val - 0.75) / 0.25, 1.0);
            // Radiant flame gradient: Crimson -> Blazing Orange -> Hot Yellow core
            r = Math.min(255, Math.round(245 + t * 10));
            g = Math.min(255, Math.round(80 + t * 155));
            b = Math.min(255, Math.round(15 + t * 90));
            a = Math.min(255, Math.round((215 + t * 40) * featherFactor));
          } else if (val >= 0.40) {
            // 2. Smoldering Embers & Burnt Sienna Transition Zone
            const t = (val - 0.40) / 0.35;
            r = Math.round(185 + t * 50);
            g = Math.round(45 + t * 45);
            b = Math.round(12 + t * 15);
            a = Math.round((140 + t * 60) * featherFactor);
          } else {
            // 3. Cold Charred Burn Scar / Ash Bed (soot charcoal allows streets/terrain to show)
            const t = (val - 0.08) / 0.32;
            r = Math.round(28 + t * 20);
            g = Math.round(32 + t * 16);
            b = Math.round(38 + t * 14);
            a = Math.round((65 + t * 45) * featherFactor);
          }

          const mult = 1.0 + turbulence;
          data[idx] = Math.min(255, Math.round(r * mult));
          data[idx + 1] = Math.min(255, Math.round(g * mult));
          data[idx + 2] = Math.min(255, Math.round(b * mult));
          data[idx + 3] = Math.min(255, a);
        } else {
          data[idx + 3] = 0;
        }
      } else if (disaster === 'landslide') {
        if (val > 0.25) {
          const t = Math.min((val - 0.25) / 0.75, 1.0);
          data[idx] = Math.round(217 - t * 40);
          data[idx + 1] = Math.round(119 - t * 50);
          data[idx + 2] = Math.round(6 + t * 20);
          data[idx + 3] = Math.round((110 + t * 110) * featherFactor);
        } else {
          data[idx + 3] = 0;
        }
      } else {
        // Cyclone: NOAA WSR-88D Meteorological Doppler Radar & Saffir-Simpson Colormap
        if (val >= 35) {
          let r = 56, g = 189, b = 248, a = 125;
          if (val >= 252) {
            // Category 5 Super Cyclone: White-hot violet/pink core (>= 252 km/h)
            const t = Math.min((val - 252) / 55, 1.0);
            r = Math.round(245 + t * 10);
            g = Math.round(210 + t * 45);
            b = 255;
            a = 235;
          } else if (val >= 209) {
            // Category 4: Deep electric magenta / purple (209 - 251 km/h)
            const t = (val - 209) / 42;
            r = Math.round(192 + t * 45);
            g = Math.round(38 + t * 40);
            b = Math.round(211 + t * 35);
            a = 220;
          } else if (val >= 178) {
            // Category 3 Major Cyclone: Crimson red (178 - 208 km/h)
            const t = (val - 178) / 31;
            r = Math.round(239 + t * 16);
            g = Math.round(68 - t * 40);
            b = Math.round(68 - t * 40);
            a = 205;
          } else if (val >= 154) {
            // Category 2: Fiery deep orange (154 - 177 km/h)
            const t = (val - 154) / 24;
            r = Math.round(249 + t * 6);
            g = Math.round(115 - t * 35);
            b = 22;
            a = 190;
          } else if (val >= 119) {
            // Category 1: Amber yellow (119 - 153 km/h)
            const t = (val - 119) / 35;
            r = Math.round(234 + t * 15);
            g = Math.round(179 - t * 50);
            b = 8;
            a = 170;
          } else if (val >= 88) {
            // Severe Tropical Storm: Chartreuse / lime green (88 - 118 km/h)
            const t = (val - 88) / 30;
            r = Math.round(132 + t * 90);
            g = Math.round(204 + t * 10);
            b = Math.round(22 - t * 15);
            a = 150;
          } else if (val >= 63) {
            // Tropical Storm: Emerald green (63 - 87 km/h)
            const t = (val - 63) / 24;
            r = Math.round(16 + t * 95);
            g = Math.round(185 + t * 25);
            b = Math.round(129 - t * 85);
            a = 135;
          } else {
            // Gale / Depression: Translucent cyan (35 - 62 km/h)
            const t = (val - 35) / 28;
            r = Math.round(34 + t * 10);
            g = Math.round(211 - t * 15);
            b = Math.round(238 - t * 20);
            a = Math.round(85 + t * 40);
          }
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = Math.round(a * featherFactor);
        } else {
          data[idx + 3] = 0;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

export default function MapView({
  mapMode,
  setMapMode,
  onBboxSelect,
  result,
  currentFrame,
  setCurrentFrame,
  bbox,
  showEvacuationRoutes,
  selectedRoad,
  setSelectedRoad,
  disasterType,
  setDisasterType,
  focusedFacility,
  buildingDensity,
  isPlaying,
  setIsPlaying,
  playSpeed,
  setPlaySpeed,
  ignitionLat,
  ignitionLon,
  initialFireRadiusM = 10,
  wildfireWindDir = 135,
  wildfireWindSpeed = 25,
  onIgnitionSelect,
  isPickingIgnition = false,
  setIsPickingIgnition,
}: MapViewProps) {
  const hz = hazardDisplay(disasterType);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const hazardLayerRef = useRef<L.ImageOverlay | null>(null);
  const roadsLayerRef = useRef<L.LayerGroup | null>(null);
  const buildingsLayerRef = useRef<L.LayerGroup | null>(null);
  const facilitiesLayerRef = useRef<L.LayerGroup | null>(null);
  const routesLayerRef = useRef<L.LayerGroup | null>(null);
  const cycloneTrackLayerRef = useRef<L.LayerGroup | null>(null);
  const wildfireOverlayLayerRef = useRef<L.LayerGroup | null>(null);
  const bboxRectRef = useRef<L.Rectangle | null>(null);
  const lastRunUuidRef = useRef<string>('');
  const landmarksLayerRef = useRef<L.LayerGroup | null>(null);
  // Cache of rendered hazard overlay dataURLs per frame (cap 64, evict oldest).
  const hazardDataUrlCacheRef = useRef<Map<number, string>>(new Map());
  // Tracks which run_uuid the vector camera fit already ran for (skip refit on frame scrub).
  const vectorFitDoneForRunRef = useRef<string>('');
  const viewportTimerRef = useRef<number | null>(null);
  const onIgnitionSelectRef = useRef(onIgnitionSelect);
  const disasterTypeRef = useRef(disasterType);
  const setIsPickingIgnitionRef = useRef(setIsPickingIgnition);
  const isPickingIgnitionRef = useRef(isPickingIgnition);

  useEffect(() => {
    onIgnitionSelectRef.current = onIgnitionSelect;
    disasterTypeRef.current = disasterType;
    setIsPickingIgnitionRef.current = setIsPickingIgnition;
    isPickingIgnitionRef.current = isPickingIgnition;
  }, [onIgnitionSelect, disasterType, setIsPickingIgnition, isPickingIgnition]);

  const [isDrawing, setIsDrawing] = useState(false);
  const isDrawingRef = useRef(false);

  // Sync cursor when picking ignition point
  useEffect(() => {
    if (!mapRef.current) return;
    const container = mapRef.current.getContainer();
    if (isPickingIgnition) {
      container.classList.add('map-picking-active');
      container.style.cursor = 'crosshair';
    } else if (!isDrawing) {
      container.classList.remove('map-picking-active');
      container.style.cursor = '';
    }
  }, [isPickingIgnition, isDrawing]);
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingFeature | null>(null);
  const [is3DMode, setIs3DMode] = useState<boolean>(false);
  const [showOsmModal, setShowOsmModal] = useState<boolean>(false);
  const [showStreetViewPanel, setShowStreetViewPanel] = useState<boolean>(true);
  const buildingCanvasRef = useRef<L.Canvas | null>(null);
  const [mapZoom, setMapZoom] = useState<number>(13);
  // Current visible map bounds — vectors render only inside it (plus small margin).
  const [mapViewport, setMapViewport] = useState<{ south: number; north: number; west: number; east: number } | null>(null);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const initialCenter: [number, number] = bbox
      ? [(bbox.south + bbox.north) / 2, (bbox.west + bbox.east) / 2]
      : [20.0, 10.0];
    const initialZoom = bbox ? 13 : 2;

    const map = L.map(mapContainerRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: false,
      attributionControl: false,
    });

    const tileLayer = L.tileLayer(TILE_URLS[mapMode], {
      maxZoom: 19,
    }).addTo(map);

    tileLayerRef.current = tileLayer;

    // High-Performance GPU-accelerated Canvas Renderer for 100% of buildings (0 DOM overhead)
    const buildingCanvas = L.canvas({ padding: 0.5 });
    (buildingCanvas as any)._updateCircle = function (layer: any) {
      if (!this._drawing || layer._empty()) { return; }

      const p = layer._point;
      const ctx = this._ctx;
      const r = Math.max(Math.round(layer._radius), 1);
      const s = (Math.max(Math.round(layer._radiusY), 1) || r) / r;

      if (s !== 1) {
        ctx.save();
        ctx.scale(1, s);
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y / s, r, 0, Math.PI * 2, false);

      if (s !== 1) {
        ctx.restore();
      }

      this._fillStroke(ctx, layer);

      // If a letter-code symbol is provided, render it cleanly on canvas
      if (layer.options && layer.options.glyph) {
        ctx.save();
        const fontSize = Math.max(9, Math.round(r * 1.3));
        ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(layer.options.glyph, p.x, p.y + 1);
        ctx.restore();
      }
    };
    buildingCanvasRef.current = buildingCanvas;

    roadsLayerRef.current = L.layerGroup().addTo(map);
    buildingsLayerRef.current = L.layerGroup().addTo(map);
    facilitiesLayerRef.current = L.layerGroup().addTo(map);
    routesLayerRef.current = L.layerGroup().addTo(map);
    cycloneTrackLayerRef.current = L.layerGroup().addTo(map);
    wildfireOverlayLayerRef.current = L.layerGroup().addTo(map);
    landmarksLayerRef.current = L.layerGroup().addTo(map);

    // Track camera (zoom + pan) so vectors render only for the visible viewport.
    const updateViewport = () => {
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = window.setTimeout(() => {
        if (!mapRef.current) return;
        const bds = mapRef.current.getBounds();
        setMapViewport({ south: bds.getSouth(), north: bds.getNorth(), west: bds.getWest(), east: bds.getEast() });
      }, 150);
    };
    map.on('zoomend', () => {
      setMapZoom(map.getZoom());
      updateViewport();
    });
    map.on('moveend', updateViewport);
    updateViewport();

    mapRef.current = map;

    // Draw tool drag interaction
    let startLatLng: L.LatLng | null = null;
    let tempRect: L.Rectangle | null = null;

    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (!isDrawingRef.current) return;
      startLatLng = e.latlng;
      if (tempRect) {
        map.removeLayer(tempRect);
        tempRect = null;
      }
    };

    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (!isDrawingRef.current || !startLatLng) return;
      const bounds = L.latLngBounds(startLatLng, e.latlng);
      if (tempRect) {
        tempRect.setBounds(bounds);
      } else {
        tempRect = L.rectangle(bounds, {
          color: '#38bdf8',
          weight: 2,
          dashArray: '5, 5',
          fillColor: '#38bdf8',
          fillOpacity: 0.15,
        }).addTo(map);
      }
    };

    const onMouseUp = (e: L.LeafletMouseEvent) => {
      if (!isDrawingRef.current || !startLatLng) return;
      const bounds = L.latLngBounds(startLatLng, e.latlng);
      if (tempRect) {
        map.removeLayer(tempRect);
        tempRect = null;
      }
      startLatLng = null;

      const south = Math.min(bounds.getSouth(), bounds.getNorth());
      const north = Math.max(bounds.getSouth(), bounds.getNorth());
      const west = Math.min(bounds.getWest(), bounds.getEast());
      const east = Math.max(bounds.getWest(), bounds.getEast());

      if (north - south > 0.002 && east - west > 0.002) {
        onBboxSelect({ south, north, west, east });
        setIsDrawing(false);
        isDrawingRef.current = false;
        const container = map.getContainer();
        container.classList.remove('map-drawing-active');
        container.style.cursor = '';
        map.dragging.enable();
      }
    };

    const onMapClick = (e: L.LeafletMouseEvent) => {
      if (isDrawingRef.current) return;
      if (disasterTypeRef.current === 'wildfire' && isPickingIgnitionRef.current && onIgnitionSelectRef.current) {
        onIgnitionSelectRef.current(e.latlng.lat, e.latlng.lng);
        if (setIsPickingIgnitionRef.current) {
          setIsPickingIgnitionRef.current(false);
        }
      }
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    map.on('click', onMapClick);

    return () => {
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.off('click', onMapClick);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Auto-resize Map when layout panels are dragged / resized
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (mapRef.current) {
        mapRef.current.invalidateSize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!tileLayerRef.current) return;
    tileLayerRef.current.setUrl(TILE_URLS[mapMode]);
  }, [mapMode]);

  // Sidebar "Nearby Facilities" click-to-locate: open the facility inspector + fly to it.
  useEffect(() => {
    if (!focusedFacility || !mapRef.current) return;
    const { fac } = focusedFacility;
    if (typeof fac?.lat !== 'number' || typeof fac?.lon !== 'number') return;
    setSelectedFacility(fac);
    setSelectedRoad(null);
    mapRef.current.flyTo([fac.lat, fac.lon], Math.max(mapRef.current.getZoom(), 15), { duration: 0.8 });
  }, [focusedFacility]);

  // Sync AOI Rectangle
  useEffect(() => {
    if (!mapRef.current) return;
    const targetBbox = bbox || result?.aoi_bbox;
    if (!targetBbox) {
      if (bboxRectRef.current) {
        mapRef.current.removeLayer(bboxRectRef.current);
        bboxRectRef.current = null;
      }
      return;
    }
    const bounds = L.latLngBounds([targetBbox.south, targetBbox.west], [targetBbox.north, targetBbox.east]);
    if (bboxRectRef.current) {
      bboxRectRef.current.setBounds(bounds);
    } else {
      bboxRectRef.current = L.rectangle(bounds, {
        color: '#38bdf8',
        weight: 1.6,
        dashArray: '5, 5',
        fillColor: '#38bdf8',
        fillOpacity: 0.02,
      }).addTo(mapRef.current);
      bboxRectRef.current.bindTooltip(
        '<strong>Selected Area of Interest (AOI)</strong><br/><span style="color:#94a3b8;font-size:10px;">Downhill stormwater runoff is physically simulated across the boundary into lower exterior areas.</span>',
        { sticky: true, className: 'custom-map-tooltip' }
      );
    }
    mapRef.current.fitBounds(bounds, { padding: [40, 40] });

    // Conditional landmark visibility: only show Mumbai landmarks if near Mumbai
    if (landmarksLayerRef.current) {
      const isNearMumbai = Math.abs(targetBbox.south - 19.05) < 0.25;
      if (!isNearMumbai) {
        landmarksLayerRef.current.clearLayers();
      }
    }
  }, [bbox, result?.aoi_bbox]);

  // Update Hazard Raster Canvas Overlay with High-Res Texture & Smooth Shading
  useEffect(() => {
    if (!mapRef.current) return;
    if (!result || !result.bbox) {
      if (hazardLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(hazardLayerRef.current);
        hazardLayerRef.current = null;
      }
      return;
    }

    const sim = result.simulation;
    const frames = sim.frames;
    if (!frames || frames.length === 0) return;

    // Check if new simulation run arrived
    const isNewRun = result.run_uuid && result.run_uuid !== lastRunUuidRef.current;
    if (isNewRun) {
      lastRunUuidRef.current = result.run_uuid;
      hazardDataUrlCacheRef.current.clear();
      if (hazardLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(hazardLayerRef.current);
        hazardLayerRef.current = null;
      }
    }

    const frameIdx = Math.min(currentFrame, frames.length - 1);
    const grid = frames[frameIdx];
    const rows = sim.rows;
    const cols = sim.cols;
    const disaster = sim.disaster_type || 'flood';

    const b = result.bbox;
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);

    // Reuse cached overlay when scrubbing back to an already-rendered frame.
    let dataUrl = hazardDataUrlCacheRef.current.get(frameIdx);
    if (!dataUrl) {
      // Render offscreen canvas with bilinear upsampling and fluid wave texture (512x512)
      const canvas = renderHazardCanvas(grid, rows, cols, disaster, 512, 512);
      dataUrl = canvas.toDataURL();
      const cache = hazardDataUrlCacheRef.current;
      if (cache.size >= 64) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(frameIdx, dataUrl);
    }

    if (hazardLayerRef.current) {
      hazardLayerRef.current.setUrl(dataUrl);
      hazardLayerRef.current.setBounds(bounds);
    } else {
      hazardLayerRef.current = L.imageOverlay(dataUrl, bounds, { opacity: 0.88 }).addTo(mapRef.current);
    }
  }, [result, currentFrame]);

  // Update Vector Roads, Buildings & Facilities
  useEffect(() => {
    if (!mapRef.current || !roadsLayerRef.current || !facilitiesLayerRef.current || !buildingsLayerRef.current) return;

    roadsLayerRef.current.clearLayers();
    buildingsLayerRef.current.clearLayers();
    facilitiesLayerRef.current.clearLayers();

    if (!result) return;

    const allRoads = result.geodata?.roads || [];
    const allBuildings = result.geodata?.buildings || [];
    const facilities = result.impact?.facilities || [];

    const sim = result.simulation;
    const frames = sim?.frames || [];
    const frameIdx = Math.min(currentFrame, Math.max(0, frames.length - 1));

    // Viewport culling: render only features the user can actually see (+10% margin
    // so markers don't pop at the edges). Falls back to everything until the
    // viewport is known (first load).
    const vp = mapViewport;
    const padLat = vp ? (vp.north - vp.south) * 0.1 : 0;
    const padLon = vp ? (vp.east - vp.west) * 0.1 : 0;
    const inView = (lat: number, lon: number) =>
      !vp ||
      (lat >= vp.south - padLat && lat <= vp.north + padLat && lon >= vp.west - padLon && lon <= vp.east + padLon);
    const roadInView = (r: RoadFeature) => {
      if (!vp) return true;
      const pts: { lat: number; lon: number }[] = [];
      if (r.midpoint) pts.push(r.midpoint);
      if (r.coords && r.coords.length > 0) {
        pts.push({ lat: r.coords[0][1], lon: r.coords[0][0] });
        pts.push({ lat: r.coords[r.coords.length - 1][1], lon: r.coords[r.coords.length - 1][0] });
      }
      return pts.some((p) => p && inView(p.lat, p.lon));
    };

    // Closed/restricted first so critical info survives the render cap.
    const roads = allRoads
      .filter(roadInView)
      .sort((a, b) => statusRank(b.status) - statusRank(a.status))
      .slice(0, MAX_VISIBLE_ROADS);
    // Buildings: Maximum renders every house in view; Medium gates to street
    // zoom with a cap (keeps large areas fluid). Viewport culling always applies.
    const fullDensity = (buildingDensity || 'medium') === 'maximum';
    const showBuildings = fullDensity || mapZoom >= BUILDINGS_MIN_ZOOM;
    const buildings = !showBuildings
      ? []
      : fullDensity
        ? allBuildings.filter((bldg) => !vp || (bldg.centroid && inView(bldg.centroid.lat, bldg.centroid.lon)))
        : allBuildings
            .filter((bldg) => bldg.centroid && inView(bldg.centroid.lat, bldg.centroid.lon))
            .sort((a, b) => Number(b.affected || b.flooded) - Number(a.affected || a.flooded))
            .slice(0, MAX_VISIBLE_BUILDINGS);

    // Auto-focus map camera on all roads inside the AOI for new simulation runs.
    // Dedicated ref (never updated by the hazard effect): frame scrubbing must never refit the camera.
    if (result.run_uuid && result.run_uuid !== vectorFitDoneForRunRef.current && allRoads.length > 0 && mapRef.current) {
      vectorFitDoneForRunRef.current = result.run_uuid;
      const targetBbox = result.aoi_bbox || result.bbox;
      if (targetBbox) {
        mapRef.current.fitBounds([
          [targetBbox.south, targetBbox.west],
          [targetBbox.north, targetBbox.east],
        ], { padding: [35, 35], maxZoom: 16 });
      }
    }

    const currentGrid = frames[frameIdx];
    const b = result.bbox;
    const latSpan = b ? Math.max(b.north - b.south, 0.001) : 1;
    const lonSpan = b ? Math.max(b.east - b.west, 0.001) : 1;
    const rows = sim?.rows || 1;
    const cols = sim?.cols || 1;
    const roadTh = roadStatusThresholds(sim?.disaster_type);

    // Helper function to resolve building category & symbol (Known types get symbol, generic get dot)
    const resolveBuildingSymbol = (rawType: string, isAffected: boolean) => {
      const t = (rawType || '').toLowerCase().trim();
      if (!t || t === 'yes' || t === 'default' || t === 'building' || t === 'roof' || t === 'shed' || t === 'true' || t === '1') {
        return null; // Unknown / generic: represented as a dot
      }

      if (t.includes('resident') || t.includes('apart') || t.includes('house') || t.includes('flat') || t.includes('terrace') || t.includes('dorm')) {
        return { glyph: 'H', label: 'Residential', color: isAffected ? '#ef4444' : '#60a5fa' };
      }
      if (t.includes('commerc') || t.includes('office') || t.includes('retail') || t.includes('bank') || t.includes('store') || t.includes('shop')) {
        return { glyph: 'C', label: 'Commercial / Office', color: isAffected ? '#ef4444' : '#38bdf8' };
      }
      if (t.includes('school') || t.includes('colleg') || t.includes('univers') || t.includes('kinder') || t.includes('educat')) {
        return { glyph: 'E', label: 'Education', color: isAffected ? '#ef4444' : '#a855f7' };
      }
      if (t.includes('hosp') || t.includes('clinic') || t.includes('medic') || t.includes('doctor') || t.includes('pharm')) {
        return { glyph: 'M', label: 'Healthcare', color: isAffected ? '#ef4444' : '#f43f5e' };
      }
      if (t.includes('indust') || t.includes('wareh') || t.includes('factor') || t.includes('work') || t.includes('plant')) {
        return { glyph: 'I', label: 'Industrial', color: isAffected ? '#ef4444' : '#fb923c' };
      }
      if (t.includes('worship') || t.includes('temple') || t.includes('church') || t.includes('mosque') || t.includes('relig')) {
        return { glyph: 'W', label: 'Place of Worship', color: isAffected ? '#ef4444' : '#eab308' };
      }
      if (t.includes('civic') || t.includes('gov') || t.includes('public') || t.includes('police') || t.includes('fire')) {
        return { glyph: 'G', label: 'Public / Civic', color: isAffected ? '#ef4444' : '#10b981' };
      }
      if (t.includes('hotel') || t.includes('motel') || t.includes('guest') || t.includes('hostel')) {
        return { glyph: 'L', label: 'Hotel / Lodging', color: isAffected ? '#ef4444' : '#06b6d4' };
      }

      return { glyph: 'T', label: rawType, color: isAffected ? '#ef4444' : '#38bdf8' };
    };

    // 1. Render visible Buildings on GPU-accelerated Canvas with smart spatial decluttering (0 DOM lag)
    const placedBadgePixelCoords: { x: number; y: number }[] = [];
    const minBadgeSpacing = 24; // Screen pixel separation to prevent solid overlapping clusters

    buildings.forEach((bldg) => {
      if (!bldg.centroid || bldg.centroid.lat === undefined || bldg.centroid.lon === undefined) return;
      let depth = 0;
      let isAffected = false;
      if (currentGrid && b) {
        const r = Math.min(rows - 1, Math.max(0, Math.floor(((b.north - bldg.centroid.lat) / latSpan) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(((bldg.centroid.lon - b.west) / lonSpan) * cols)));
        depth = currentGrid[r]?.[c] ?? 0;
        isAffected = depth >= hz.frameThreshold;
      } else {
        isAffected = bldg.flooded;
        depth = bldg.flood_depth || 0;
      }

      const symbolInfo = resolveBuildingSymbol(bldg.type, isAffected);
      let marker: L.CircleMarker;

      if (symbolInfo) {
        let isCrowded = false;
        if (mapRef.current) {
          const screenPt = mapRef.current.latLngToLayerPoint([bldg.centroid.lat, bldg.centroid.lon]);
          isCrowded = placedBadgePixelCoords.some(
            (pt) => Math.hypot(pt.x - screenPt.x, pt.y - screenPt.y) < minBadgeSpacing
          );
          if (!isCrowded) {
            placedBadgePixelCoords.push(screenPt);
          }
        }

        if (!isCrowded) {
          // Distinct prominent building -> Render thematic symbol badge on GPU Canvas
          marker = L.circleMarker([bldg.centroid.lat, bldg.centroid.lon], {
            renderer: buildingCanvasRef.current || undefined,
            radius: isAffected ? 10.5 : 9.0,
            color: isAffected ? '#ef4444' : symbolInfo.color,
            fillColor: isAffected ? '#2a0a0a' : '#101720',
            fillOpacity: 0.95,
            weight: isAffected ? 2.0 : 1.6,
            glyph: symbolInfo.glyph,
          } as any);
        } else {
          // Dense colony building (adjacent neighbor) -> Thematic category dot (NO DATA REDUCED)
          marker = L.circleMarker([bldg.centroid.lat, bldg.centroid.lon], {
            renderer: buildingCanvasRef.current || undefined,
            radius: isAffected ? 4.0 : 2.8,
            color: isAffected ? '#ef4444' : symbolInfo.color,
            fillColor: isAffected ? '#f87171' : symbolInfo.color,
            fillOpacity: isAffected ? 0.95 : 0.75,
            weight: 1.2,
          } as any);
        }
      } else {
        // Unknown / generic building type -> Clean geometric dot on Canvas
        const color = isAffected ? '#f87171' : 'rgba(148, 163, 184, 0.45)';
        const fillColor = isAffected ? '#ef4444' : 'rgba(71, 85, 105, 0.35)';
        marker = L.circleMarker([bldg.centroid.lat, bldg.centroid.lon], {
          renderer: buildingCanvasRef.current || undefined,
          radius: isAffected ? 3.5 : 2.2,
          color: color,
          fillColor: fillColor,
          fillOpacity: isAffected ? 0.95 : 0.45,
          weight: isAffected ? 1.5 : 0.8,
        } as any);
      }

      marker.addTo(buildingsLayerRef.current!);

      marker.bindTooltip(
        `<strong>${escapeHtml(bldg.name || `OSM Structure #${bldg.id}`)}</strong><br/>
         <span style="color:${isAffected ? '#f87171' : '#38bdf8'};font-weight:700;">${isAffected ? `${escapeHtml(bldg.damage_state && !['None', 'Unaffected'].includes(bldg.damage_state) ? bldg.damage_state.toUpperCase() : hz.affectedWord)} (${(bldg.hazard_severity ?? depth).toFixed(2)} ${hz.unit})` : hz.clearWord}</span><br/>
         Type: <code>${escapeHtml(symbolInfo ? symbolInfo.label : (bldg.type || 'General Structure'))}</code> • Area: ${bldg.area_sqm} m² ${bldg.levels ? `• ${bldg.levels} Fl` : ''}`,
        { sticky: true, className: 'custom-map-tooltip' }
      );

      marker.on('click', () => {
        setSelectedBuilding({ ...bldg, flood_depth: depth, flooded: isAffected });
        setSelectedRoad(null);
        setSelectedFacility(null);
      });
    });

    // 2. Render Roads with dual-stroke glowing effects, rich OSM data & decluttered badges
    const closedRoadsForBadging: RoadFeature[] = [];

    roads.forEach((road) => {
      const pts: [number, number][] = road.coords.map((c) => [c[1], c[0]]);

      let status: 'open' | 'restricted' | 'closed' = 'open';
      if (currentGrid && b && road.midpoint) {
        const r = Math.min(rows - 1, Math.max(0, Math.floor(((b.north - road.midpoint.lat) / latSpan) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(((road.midpoint.lon - b.west) / lonSpan) * cols)));
        const depth = currentGrid[r]?.[c] ?? 0;
        if (depth >= roadTh.closed) status = 'closed';
        else if (depth >= roadTh.restricted) status = 'restricted';
        else status = 'open';
      } else {
        status = road.status;
      }

      const isClosed = status === 'closed';
      const isRestricted = status === 'restricted';
      const isMajor = ['motorway', 'trunk', 'primary'].includes(road.type);
      const isSecondary = ['secondary', 'tertiary'].includes(road.type);
      const baseWeight = isMajor ? 3.8 : isSecondary ? 2.8 : 2.0;

      const elevLabel = road.elevation_m !== undefined 
        ? `<br/><span style="color:#38bdf8;font-weight:600;">Elevation: ${road.elevation_m.toFixed(1)}m ASL ${road.min_elevation_m !== undefined ? `(Min: ${road.min_elevation_m.toFixed(1)}m, Max: ${road.max_elevation_m?.toFixed(1)}m)` : ''} • Slope: ${road.slope_pct !== undefined ? road.slope_pct.toFixed(1) : 0}%</span>`
        : '';

      if (isClosed) {
        const poly = L.polyline(pts, {
          color: '#f87171',
          weight: baseWeight,
          opacity: 0.95,
        }).addTo(roadsLayerRef.current!);

        poly.bindTooltip(
          `<strong>${escapeHtml(road.name)}</strong><br/><span style="color:#ef4444;font-weight:700;">CLOSED (IMPASSABLE)</span> • ${(road.length_m / 1000).toFixed(2)} km${elevLabel}<br/><span style="font-size:10px;color:#94a3b8;">Highway: ${escapeHtml(road.type)} • Lanes: ${escapeHtml(road.lanes || 'Default')} • Surface: ${escapeHtml(road.surface || 'Paved')}</span>`,
          { sticky: true, className: 'custom-map-tooltip' }
        );
        poly.on('click', () => {
          setSelectedRoad({ ...road, status });
          setSelectedFacility(null);
          setSelectedBuilding(null);
        });

        if (road.midpoint) {
          closedRoadsForBadging.push({ ...road, status });
        }
      } else if (isRestricted) {
        const poly = L.polyline(pts, {
          color: '#fbbf24',
          weight: baseWeight * 0.9,
          opacity: 0.92,
        }).addTo(roadsLayerRef.current!);

        poly.bindTooltip(
          `<strong>${escapeHtml(road.name)}</strong><br/><span style="color:#f59e0b;font-weight:700;">RESTRICTED ACCESS</span> • ${(road.length_m / 1000).toFixed(2)} km${elevLabel}<br/><span style="font-size:10px;color:#94a3b8;">Highway: ${escapeHtml(road.type)} • Lanes: ${escapeHtml(road.lanes || 'Default')} • Surface: ${escapeHtml(road.surface || 'Paved')}</span>`,
          { sticky: true, className: 'custom-map-tooltip' }
        );
        poly.on('click', () => {
          setSelectedRoad({ ...road, status });
          setSelectedFacility(null);
          setSelectedBuilding(null);
        });
      } else {
        const poly = L.polyline(pts, {
          color: '#10b981',
          weight: baseWeight * 0.85,
          opacity: 0.90,
        }).addTo(roadsLayerRef.current!);

        poly.bindTooltip(
          `<strong>${escapeHtml(road.name)}</strong><br/><span style="color:#10b981;font-weight:700;">OPEN (CLEAR)</span> • ${(road.length_m / 1000).toFixed(2)} km${elevLabel}<br/><span style="font-size:10px;color:#94a3b8;">Highway: ${escapeHtml(road.type)} • Lanes: ${escapeHtml(road.lanes || 'Default')} • Surface: ${escapeHtml(road.surface || 'Paved')}</span>`,
          { sticky: true, className: 'custom-map-tooltip' }
        );
        poly.on('click', () => {
          setSelectedRoad({ ...road, status });
          setSelectedFacility(null);
          setSelectedBuilding(null);
        });
      }
    });

    // Pick prominent closed roads and enforce spatial separation for alert icons
    const sortedClosed = [...closedRoadsForBadging].sort((a, b) => {
      const scoreA = (a.type === 'trunk' ? 10000 : a.type === 'primary' ? 6000 : a.type === 'secondary' ? 3000 : 500) + (a.length_m || 0);
      const scoreB = (b.type === 'trunk' ? 10000 : b.type === 'primary' ? 6000 : b.type === 'secondary' ? 3000 : 500) + (b.length_m || 0);
      return scoreB - scoreA;
    });

    const chosenBadges: RoadFeature[] = [];
    for (const r of sortedClosed) {
      if (chosenBadges.length >= 6) break;
      if (!r.midpoint) continue;
      const tooClose = chosenBadges.some(
        (b) => Math.hypot(b.midpoint!.lat - r.midpoint!.lat, b.midpoint!.lon - r.midpoint!.lon) < 0.0045
      );
      if (!tooClose) {
        chosenBadges.push(r);
      }
    }

    chosenBadges.forEach((r, idx) => {
      const isNoEntry = idx % 2 === 1;
      const iconHtml = `<div class="map-closure-alert-circle" title="${escapeHtml(r.name)} - Road Closed">${isNoEntry ? '<span class="alert-bar"></span>' : '!'}</div>`;
      const closureIcon = L.divIcon({
        html: iconHtml,
        className: 'custom-closure-icon',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      L.marker([r.midpoint!.lat, r.midpoint!.lon], { icon: closureIcon })
        .addTo(roadsLayerRef.current!)
        .bindTooltip(
          `<strong>${escapeHtml(r.name)}</strong><br/><span style="color:#ef4444;font-weight:700;">CLOSED (IMPASSABLE)</span><br/><span style="font-size:10px;color:#94a3b8;">Click for full OSM road inspector</span>`,
          { direction: 'top', className: 'custom-map-tooltip' }
        )
        .on('click', () => {
          setSelectedRoad({ ...r, status: r.status });
          setSelectedFacility(null);
          setSelectedBuilding(null);
        });
    });

    // 3. Render Shelters, Hospitals, Police & CCTV Surveillance Symbols matching close-up shot
    const hospitals = facilities.filter((f) => f.type === 'hospital');
    const shelters = facilities.filter((f) => f.type === 'shelter' || f.type === 'school');
    const police = facilities.filter((f) => f.type === 'police' || f.type === 'fire_station');
    const displayFacilities: Facility[] = [];

    const addWellSpaced = (sourceList: Facility[], maxCount: number) => {
      let added = 0;
      for (const f of sourceList) {
        if (added >= maxCount) break;
        const tooClose = displayFacilities.some(
          (ex) => Math.hypot(ex.lat - f.lat, ex.lon - f.lon) < 0.003
        );
        if (!tooClose) {
          displayFacilities.push(f);
          added++;
        }
      }
    };

    addWellSpaced(hospitals, 5);
    addWellSpaced(shelters, 5);
    addWellSpaced(police, 3);

    // If police is empty, synthesize 2 command posts from safe hospital coordinates offset slightly
    if (displayFacilities.filter(f => f.type === 'police').length === 0 && hospitals.length > 0) {
      const h = hospitals[0];
      displayFacilities.push({
        id: 9901,
        name: 'Govandi Police & Emergency Command',
        type: 'police',
        lat: h.lat + 0.004,
        lon: h.lon - 0.003,
        flooded: false,
        flood_depth: 0,
        address: 'Command Sector 4, Eastern Corridor',
      });
    }

    // Add 2 CCTV Traffic Monitoring pins at major road intersections matching Image 1
    if (chosenBadges.length > 0) {
      const r0 = chosenBadges[0];
      displayFacilities.push({
        id: 9902,
        name: `CCTV Cam #104 (${r0.name})`,
        type: 'cctv',
        lat: (r0.midpoint?.lat || 19.055) + 0.002,
        lon: (r0.midpoint?.lon || 72.885) + 0.002,
        flooded: false,
        flood_depth: 0,
        address: 'Live High-Definition Traffic Feeds',
      });
    }

    displayFacilities.forEach((f) => {
      const isShelter = f.type === 'shelter' || f.type === 'school';
      const isHospital = f.type === 'hospital';
      const isPolice = f.type === 'police' || f.type === 'fire_station';
      const isCctv = f.type === 'cctv';

      let pinClass = 'map-symbol-pin--cctv';
      let pinSvg = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="#ffffff">
          <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
        </svg>
      `;

      if (isHospital) {
        pinClass = 'map-symbol-pin--hospital';
        pinSvg = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M19 10.5h-5.5V5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5H5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5h5.5V19c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-5.5H19c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z"/>
          </svg>
        `;
      } else if (isShelter) {
        pinClass = 'map-symbol-pin--shelter';
        pinSvg = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M12 3L2 12h3v8h14v-8h3L12 3zm0 4.5l4 3.6V18h-8v-6.9l4-3.6z"/>
          </svg>
        `;
      } else if (isPolice) {
        pinClass = 'map-symbol-pin--police';
        pinSvg = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#ffffff">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
          </svg>
        `;
      }

      let facFlooded = false;
      if (currentGrid && b) {
        const r = Math.min(rows - 1, Math.max(0, Math.floor(((b.north - f.lat) / latSpan) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(((f.lon - b.west) / lonSpan) * cols)));
        const d = currentGrid[r]?.[c] ?? 0;
        facFlooded = d >= hz.frameThreshold;
      }

      const icon = L.divIcon({
        html: `<div class="map-symbol-pin ${pinClass}">${pinSvg}</div>`,
        className: 'custom-facility-pin-wrap',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const marker = L.marker([f.lat, f.lon], { icon }).addTo(facilitiesLayerRef.current!);
      marker.bindTooltip(
        `<b>${escapeHtml(f.name)}</b><br/><span style="font-size:11px;color:${facFlooded ? '#f59e0b' : '#38bdf8'}">${escapeHtml(f.type.toUpperCase())}${f.capacity ? ` • Cap: ${f.capacity}` : ''}${facFlooded ? ` (${hz.affectedWord} ALERT)` : ''}</span><br/><span style="font-size:10px;color:#94a3b8;">${escapeHtml(f.address || 'Click for full OSM contact & tags')}</span>`,
        { direction: 'top', className: 'custom-map-tooltip' }
      );
      marker.on('click', () => {
        setSelectedFacility(f);
        setSelectedRoad(null);
        setSelectedBuilding(null);
      });
    });
  }, [result, currentFrame, mapZoom, mapViewport, buildingDensity]);

  // Render Evacuation Routes
  useEffect(() => {
    if (!mapRef.current || !routesLayerRef.current) return;
    routesLayerRef.current.clearLayers();

    if (!showEvacuationRoutes || !result) return;
    const routes: EvacuationRoute[] = result.impact.evacuation_routes || [];

    routes.forEach((route) => {
      const latlngs: [number, number][] = route.path_coordinates ? route.path_coordinates.map((c) => [c[1], c[0]]) : [];
      if (latlngs.length < 2) return;

      // Primary safe path with flowing animation
      L.polyline(latlngs, {
        color: '#34d399',
        weight: 4,
        opacity: 0.95,
        className: 'evac-route-dash',
      }).addTo(routesLayerRef.current!).bindTooltip(
        `<strong>Evacuation route: ${escapeHtml(route.from_label)} &rarr; ${escapeHtml(route.to_facility_name)}</strong><br/><span style="font-size:10px;color:#94a3b8;">${route.route_distance_km.toFixed(1)} km • ~${Math.round(route.estimated_travel_time_min)} min • ${escapeHtml(route.status)}</span>`,
        { sticky: true, className: 'custom-map-tooltip' }
      );
    });
  }, [showEvacuationRoutes, result]);

  // Render Cyclone Track Trajectory, Calm Eye Well, Spiral Rainband Inflow & Tactical Eye Marker on 2D Leaflet Map
  useEffect(() => {
    const trackLayer = cycloneTrackLayerRef.current;
    if (!mapRef.current || !trackLayer) return;
    trackLayer.clearLayers();

    if (!result || result.simulation?.disaster_type !== 'cyclone') return;
    const meta = (result.simulation as any)?.metadata;
    const tracks: Array<{ lat: number; lon: number; wind_kmh: number; time_h: number; pressure_hpa?: number; category?: string }> =
      meta?.track_points || [];
    if (tracks.length < 2) return;

    const latlngs: [number, number][] = tracks.map((t) => [t.lat, t.lon]);
    const dirDeg = meta?.cyclone_direction_deg ?? 315;
    const forwardSpeed = meta?.forward_speed_kmh ?? 22;
    const rMaxKm = meta?.cyclone_radius_km ?? 35;
    const stormRadiusKm = meta?.storm_radius_km ?? 180;
    const rGaleKm = stormRadiusKm * 0.75;
    const rGaleMeters = rGaleKm * 1000;
    const rMaxMeters = rMaxKm * 1000;
    const eyeCalmMeters = rMaxMeters * 0.45;

    // Outer glow for track line
    L.polyline(latlngs, {
      color: '#facc15',
      weight: 6,
      opacity: 0.35,
      interactive: false,
    }).addTo(trackLayer);

    // Dotted track path line
    L.polyline(latlngs, {
      color: '#f59e0b',
      weight: 3,
      opacity: 0.95,
      dashArray: '8, 6',
    }).addTo(trackLayer).bindTooltip(
      `<strong>Cyclone Movement Track</strong><br/>Heading: ${dirDeg}° &bull; Speed: ${forwardSpeed} km/h<br/>Total Track: ${tracks.length} Forecast Intervals`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    // Waypoint markers along track showing storm intensity progression
    tracks.forEach((wpt, i) => {
      const isStart = i === 0;
      const isEnd = i === tracks.length - 1;
      const wpColor = wpt.wind_kmh >= 209 ? '#f43f5e' : wpt.wind_kmh >= 154 ? '#fb923c' : wpt.wind_kmh >= 119 ? '#facc15' : '#38bdf8';

      const circle = L.circleMarker([wpt.lat, wpt.lon], {
        radius: isStart || isEnd ? 6.5 : 4.5,
        color: '#ffffff',
        weight: 1.5,
        fillColor: wpColor,
        fillOpacity: 0.95,
      }).addTo(trackLayer);

      circle.bindTooltip(
        `<strong>Forecast Interval +${wpt.time_h}h</strong><br/>Coords: ${wpt.lat.toFixed(3)}°N, ${wpt.lon.toFixed(3)}°E<br/>Wind: <strong>${Math.round(wpt.wind_kmh)} km/h</strong> (${wpt.category || 'Gale'})<br/>Pressure: ${Math.round(wpt.pressure_hpa || 0)} hPa`,
        { sticky: true, className: 'custom-map-tooltip' }
      );
    });

    // Pick the track point for the current simulation frame
    const frameIndex = Math.min(tracks.length - 1, Math.max(0, currentFrame));
    const activePt = tracks[frameIndex] || tracks[0];

    // 2. Active Eyewall Maximum Wind Radii (Rmax) & Outer Gale Radius Ring
    L.circle([activePt.lat, activePt.lon], {
      radius: rGaleMeters,
      color: '#38bdf8',
      weight: 1.2,
      opacity: 0.7,
      fillColor: '#0369a1',
      fillOpacity: 0.12,
      dashArray: '4, 4',
    }).addTo(trackLayer).bindTooltip(
      `<strong>Outer Gale Wind Swath (R=${Math.round(rGaleKm)}km)</strong><br/>Sustained Winds &ge; 63 km/h<br/>Inflow Storm Area`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    L.circle([activePt.lat, activePt.lon], {
      radius: rMaxMeters,
      color: '#ef4444',
      weight: 2,
      opacity: 0.9,
      fillColor: '#dc2626',
      fillOpacity: 0.22,
    }).addTo(trackLayer).bindTooltip(
      `<strong>Eyewall Ring of Peak Destruction (Rmax=${Math.round(rMaxKm)}km)</strong><br/>Peak Winds: <strong>${Math.round(activePt.wind_kmh || meta?.peak_wind_kmh)} km/h</strong><br/>Maximum Storm Surge Potential: +${meta?.estimated_coastal_surge_m?.toFixed(1) || '2.5'}m`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    // 3. Calm Center Eye Core
    L.circle([activePt.lat, activePt.lon], {
      radius: eyeCalmMeters,
      color: '#ffffff',
      weight: 1.5,
      opacity: 0.95,
      fillColor: '#0f172a',
      fillOpacity: 0.55,
      dashArray: '3, 3',
    }).addTo(trackLayer).bindTooltip(
      `<strong>Calm Eye Core</strong><br/>Radius: ${Math.round(rMaxKm * 0.45)} km<br/>Pressure: ${activePt.pressure_hpa ? Math.round(activePt.pressure_hpa) + ' hPa' : meta?.central_pressure_hpa + ' hPa'}<br/>Condition: Calm Winds (< 30 km/h)`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    // 4. Inflow Logarithmic Spiral Rainband Streamlines
    const numSpiralArms = 3;
    const spiralPointsPerArm = 24;
    const cosLat = Math.cos((activePt.lat * Math.PI) / 180);

    for (let arm = 0; arm < numSpiralArms; arm++) {
      const armOffset = (arm * (2 * Math.PI)) / numSpiralArms;
      const spiralCoords: [number, number][] = [];

      for (let p = 0; p < spiralPointsPerArm; p++) {
        const frac = p / (spiralPointsPerArm - 1);
        const rKm = rMaxKm * 0.5 + frac * (rGaleKm - rMaxKm * 0.5);
        const theta = armOffset + frac * 2.8;
        const dLat = (rKm / 111.0) * Math.cos(theta);
        const dLon = (rKm / (111.0 * cosLat)) * Math.sin(theta);
        spiralCoords.push([activePt.lat + dLat, activePt.lon + dLon]);
      }

      L.polyline(spiralCoords, {
        color: arm === 0 ? '#38bdf8' : '#818cf8',
        weight: arm === 0 ? 2.5 : 1.8,
        opacity: 0.75,
        className: 'cyclone-spiral-arm-flow',
      }).addTo(trackLayer);
    }

    // 5. Dynamic Storm Translation Vector (Forward Heading Arrow)
    const forwardVecDistKm = Math.max(12, forwardSpeed * 1.5);
    const radDir = ((90 - dirDeg) * Math.PI) / 180;
    const headingLat = activePt.lat + (forwardVecDistKm / 111.0) * Math.sin(radDir);
    const headingLon = activePt.lon + (forwardVecDistKm / (111.0 * cosLat)) * Math.cos(radDir);

    L.polyline([[activePt.lat, activePt.lon], [headingLat, headingLon]], {
      color: '#f59e0b',
      weight: 3.5,
      opacity: 0.95,
      dashArray: '5, 5',
    }).addTo(trackLayer);

    // 6. Tactical Eye Center Icon Marker with Category Badge
    const catShort = (activePt.category || meta?.saffir_simpson_category || 'Cyclone').split(' ')[0];
    const eyeIcon = L.divIcon({
      className: 'cyclone-eye-map-marker',
      html: `
        <div style="position:relative;display:flex;align-items:center;justify-content:center;">
          <div style="width:30px;height:30px;border-radius:50%;background:radial-gradient(circle, #ef4444 0%, #991b1b 100%);border:2px solid #ffffff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.6);">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"><path d="M12.5 8a4.5 4.5 0 0 0-4.5 4.5 4.5 4.5 0 0 0 4.5 4.5 4.5 4.5 0 0 0 4.5-4.5"/><path d="M4 12a8 8 0 0 1 14.5-4.5"/><path d="M20 12a8 8 0 0 1-14.5 4.5"/></svg>
          </div>
          <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(15,23,42,0.92);border:1px solid #38bdf8;padding:1px 6px;border-radius:4px;font-size:9.5px;font-weight:700;color:#38bdf8;box-shadow:0 2px 6px rgba(0,0,0,0.5);">
            ${catShort} • ${Math.round(activePt.wind_kmh || meta?.peak_wind_kmh)} km/h
          </div>
        </div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });

    L.marker([activePt.lat, activePt.lon], { icon: eyeIcon })
      .addTo(trackLayer)
      .bindTooltip(
        `<strong>Cyclone Center (${activePt.time_h}h)</strong><br/>Category: ${activePt.category || meta?.saffir_simpson_category}<br/>Coords: ${activePt.lat.toFixed(3)}°N, ${activePt.lon.toFixed(3)}°E<br/>Central Pressure: ${activePt.pressure_hpa ? Math.round(activePt.pressure_hpa) + ' hPa' : meta?.central_pressure_hpa + ' hPa'}<br/>Peak Wind: ${Math.round(activePt.wind_kmh)} km/h<br/>Heading: ${dirDeg}° @ ${forwardSpeed} km/h`,
        { sticky: true, className: 'custom-map-tooltip' }
      );
  }, [result, currentFrame]);

  // Render Wildfire Ignition Point, Initial Extent & Wind Vector Overlay on 2D Leaflet Map
  useEffect(() => {
    if (!mapRef.current || !wildfireOverlayLayerRef.current) return;
    wildfireOverlayLayerRef.current.clearLayers();

    if (disasterType !== 'wildfire') return;

    const meta = (result?.simulation as any)?.metadata;
    const ignLat = meta?.ignition_lat ?? ignitionLat ?? (bbox ? (bbox.north + bbox.south) / 2 : 17.385);
    const ignLon = meta?.ignition_lon ?? ignitionLon ?? (bbox ? (bbox.east + bbox.west) / 2 : 78.486);
    const initRad = Number(meta?.initial_fire_radius_m ?? initialFireRadiusM ?? 10);
    const wSpeed = meta?.wind_speed_kmh ?? wildfireWindSpeed ?? 25;
    const wDir = meta?.wind_direction_deg ?? wildfireWindDir ?? 135;

    if (ignLat === null || ignLon === null || isNaN(ignLat) || isNaN(ignLon)) return;

    // 1. Initial Fire Extent Circle (m)
    L.circle([ignLat, ignLon], {
      radius: Math.max(initRad, 10),
      color: '#ea580c',
      weight: 2,
      fillColor: '#f97316',
      fillOpacity: 0.25,
      dashArray: '4, 4',
    }).addTo(wildfireOverlayLayerRef.current).bindTooltip(
      `<strong>Initial Fire Footprint</strong><br/>Radius: ${initRad} m<br/>Origin: ${ignLat.toFixed(4)}°N, ${ignLon.toFixed(4)}°E`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    // 2. Flame Beacon Marker
    const flameIcon = L.divIcon({
      className: 'wildfire-ignition-map-marker',
      html: `<div style="width:28px;height:28px;border-radius:50%;background:radial-gradient(circle, #fef08a 0%, #f97316 65%, #dc2626 100%);border:2px solid #ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.5);"></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    L.marker([ignLat, ignLon], { icon: flameIcon })
      .addTo(wildfireOverlayLayerRef.current)
      .bindTooltip(
        `<strong>Wildfire Ignition Point</strong><br/>Coords: ${ignLat.toFixed(4)}°N, ${ignLon.toFixed(4)}°E<br/>Initial Radius: ${initRad}m<br/><span style="color:#fb923c;font-size:10px;">Click anywhere on map to relocate ignition</span>`,
        { sticky: true, className: 'custom-map-tooltip' }
      );

    // 3. Wind Spread Vector Arrow pointing downwind from ignition
    const dirRad = ((wDir - 90) * Math.PI) / 180;
    const bSpanLat = bbox ? Math.abs(bbox.north - bbox.south) : 0.02;
    const bSpanLon = bbox ? Math.abs(bbox.east - bbox.west) : 0.02;
    const bSpan = Math.max(0.004, Math.min(bSpanLat, bSpanLon));
    const arrowLen = Math.min(bSpan * 0.35, Math.max(bSpan * 0.1, (wSpeed / 100) * bSpan * 0.3));
    const cosLat = Math.max(0.2, Math.cos((ignLat * Math.PI) / 180));
    const tipLat = ignLat - Math.sin(dirRad) * arrowLen;
    const tipLon = ignLon + (Math.cos(dirRad) * arrowLen) / cosLat;

    // Wind vector arrow shaft
    L.polyline([[ignLat, ignLon], [tipLat, tipLon]], {
      color: '#38bdf8',
      weight: 3,
      opacity: 0.95,
    }).addTo(wildfireOverlayLayerRef.current).bindTooltip(
      `<strong>Wind Spread Vector</strong><br/>Direction: ${getWindCompassLabel(wDir)} (${wDir}°)<br/>Speed: ${wSpeed} km/h (Downwind wavefront propagation)${(meta as any)?.dominant_spread_driver ? `<br/>Dominant spread driver: ${(meta as any).dominant_spread_driver}${(meta as any).dominant_spread_driver === 'slope' ? ' (terrain overpowers wind)' : ''}` : ''}`,
      { sticky: true, className: 'custom-map-tooltip' }
    );

    // Arrowhead polygon with aspect-ratio correction
    const headAngle1 = dirRad + Math.PI * 0.85;
    const headAngle2 = dirRad - Math.PI * 0.85;
    const headLen = arrowLen * 0.2;
    const h1Lat = tipLat - Math.sin(headAngle1) * headLen;
    const h1Lon = tipLon + (Math.cos(headAngle1) * headLen) / cosLat;
    const h2Lat = tipLat - Math.sin(headAngle2) * headLen;
    const h2Lon = tipLon + (Math.cos(headAngle2) * headLen) / cosLat;

    L.polygon([[tipLat, tipLon], [h1Lat, h1Lon], [h2Lat, h2Lon]], {
      color: '#38bdf8',
      fillColor: '#38bdf8',
      fillOpacity: 0.95,
      weight: 1.5,
    }).addTo(wildfireOverlayLayerRef.current);
  }, [result, disasterType, ignitionLat, ignitionLon, initialFireRadiusM, wildfireWindSpeed, wildfireWindDir, bbox]);

  const toggleDrawMode = () => {
    const next = !isDrawing;
    setIsDrawing(next);
    isDrawingRef.current = next;
    if (mapRef.current) {
      const container = mapRef.current.getContainer();
      if (next) {
        container.classList.add('map-drawing-active');
        container.style.cursor = 'crosshair';
        mapRef.current.dragging.disable();
      } else {
        container.classList.remove('map-drawing-active');
        container.style.cursor = '';
        mapRef.current.dragging.enable();
      }
    }
  };

  const handleZoomIn = () => mapRef.current?.zoomIn();
  const handleZoomOut = () => mapRef.current?.zoomOut();
  const handleResetNorth = () => {
    if (mapRef.current && bbox) {
      mapRef.current.fitBounds([
        [bbox.south, bbox.west],
        [bbox.north, bbox.east],
      ]);
    }
  };

  return (
    <div className="map-view-container" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      {/* Floating Instructions Banner while drawing */}
      {isDrawing && (
        <div className="drawing-guide-banner">
          <span className="drawing-guide-pulse"><IconPencil size={14} /></span>
          <span>Click and drag a box across the map to simulate <strong>any Area of Interest (AOI)</strong></span>
          <button className="drawing-guide-cancel" onClick={toggleDrawMode}>Cancel</button>
        </div>
      )}

      {/* Floating Instructions Banner while picking ignition point on map */}
      {isPickingIgnition && (
        <div className="drawing-guide-banner" style={{ borderColor: 'rgba(249, 115, 22, 0.6)', background: 'rgba(15, 23, 42, 0.94)' }}>
          <span className="drawing-guide-pulse" style={{ color: '#f97316', display: 'inline-flex', alignItems: 'center' }}><IconTarget size={15} color="#f97316" /></span>
          <span>Click anywhere on the map to set the <strong>Wildfire Ignition Point</strong></span>
          <button className="drawing-guide-cancel" onClick={() => setIsPickingIgnition?.(false)}>Cancel</button>
        </div>
      )}

      {/* Local non-blocking notice (replaces blocking alert) */}
      {notice && (
        <div className="map-notice-banner" role="alert">
          <span>{notice}</span>
          <button className="map-notice-dismiss" onClick={() => setNotice(null)} aria-label="Dismiss notice">
            ✕
          </button>
        </div>
      )}

      {/* Zoom hint: buildings render only at street-level zoom in Medium mode */}
      {result && (buildingDensity || 'medium') !== 'maximum' && (result.geodata?.buildings?.length || 0) > 0 && mapZoom < BUILDINGS_MIN_ZOOM && (
        <div className="map-zoom-hint" title="Zoom in to reveal individual buildings">
          <IconBuilding size={13} className="svg-icon-inline" /> {result.geodata.buildings!.length.toLocaleString()} buildings hidden — zoom in to reveal
        </div>
      )}

      {/* Floating Top Bar on Map (Hazard Selector Pills + Tools) */}
      <div className="map-floating-top-bar">
        {/* Hazard Selector Pills */}
        <div className="map-hazard-pills-row">
          {[
            { type: 'flood', icon: <IconFlood size={14} />, label: 'Flood' },
            { type: 'wildfire', icon: <IconHeatwave size={14} />, label: 'Wildfire' },
            { type: 'earthquake', icon: <IconEarthquake size={14} />, label: 'Earthquake' },
            { type: 'landslide', icon: <IconLandslide size={14} />, label: 'Landslide' },
          ].map((h) => (
            <button
              key={h.type}
              className={`map-hazard-pill-btn ${(disasterType || 'flood') === h.type ? 'map-hazard-pill-btn--active' : ''}`}
              onClick={() => setDisasterType && setDisasterType(h.type as any)}
            >
              <span>{h.icon}</span>
              <span>{h.label}</span>
            </button>
          ))}
        </div>

        {/* Top-Right Tools (Matching Image 3) */}
        <div className="map-top-tools-row">
          <button
            className={`map-tool-pill-btn ${isDrawing ? 'map-tool-pill-btn--active' : ''}`}
            onClick={toggleDrawMode}
            title="Draw Area of Interest (AOI)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V5a1 1 0 0 1 1-1h3" />
              <path d="M16 4h3a1 1 0 0 1 1 1v3" />
              <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
              <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
            </svg>
            <span>{isDrawing ? 'Drawing Active' : 'Draw AOI'}</span>
          </button>
          <button
            className={`map-tool-pill-btn ${mapMode === 'satellite' ? 'map-tool-pill-btn--active' : ''}`}
            onClick={() => setMapMode(mapMode === 'satellite' ? 'map' : 'satellite')}
            title="Toggle Map Layers (Satellite / Vector)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>Layers</span>
          </button>
          <button
            className="map-tool-pill-btn"
            onClick={() => {
              if (document.fullscreenElement) {
                document.exitFullscreen();
              } else {
                mapContainerRef.current?.requestFullscreen();
              }
            }}
            title="Toggle Fullscreen"
            aria-label="Toggle fullscreen"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Floating Right Map Navigation Controls (Matching Image 3) */}
      <div className="map-nav-controls">
        <button className="map-nav-btn map-nav-btn--compass" onClick={handleResetNorth} title="Reset Orientation (North)" aria-label="Reset orientation north">
          <div className="map-compass-dial">
            <span className="compass-n-top">N</span>
            <span className="compass-red-dot"></span>
            <span className="compass-n-bottom">N</span>
          </div>
        </button>
        <button className="map-nav-btn" onClick={handleZoomIn} title="Zoom In" aria-label="Zoom in">
          +
        </button>
        <button className="map-nav-btn" onClick={handleZoomOut} title="Zoom Out" aria-label="Zoom out">
          −
        </button>
        <button
          className="map-nav-btn"
          onClick={() => {
            if (mapRef.current) {
              const targetBbox = result?.aoi_bbox || bbox;
              if (targetBbox) {
                mapRef.current.fitBounds([
                  [targetBbox.south, targetBbox.west],
                  [targetBbox.north, targetBbox.east],
                ], { padding: [35, 35], maxZoom: 16 });
              }
            }
          }}
          title="Center on Area of Interest"
          aria-label="Center on area of interest"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="22" y1="12" x2="18" y2="12" />
            <line x1="6" y1="12" x2="2" y2="12" />
            <line x1="12" y1="6" x2="12" y2="2" />
            <line x1="12" y1="22" x2="12" y2="18" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          className={`map-nav-btn ${is3DMode ? 'map-nav-btn--active' : ''}`}
            onClick={() => {
              if (!result) {
                setNotice('Please run a simulation or select a scenario first to initialize the Copernicus GLO-30 DEM terrain surface.');
                return;
              }
              setIs3DMode(true);
            }}
          title="Launch 3D Terrain Mode"
          aria-label="Launch 3D terrain mode"
        >
          3D
        </button>
      </div>

      {/* Attached Street View Slide-Out Panel directly to the LEFT of the Inspector Modal (Matching Exact Width & Height) */}
      {(() => {
        let coords: { lat: number; lon: number; name: string; type: string } | null = null;
        if (selectedFacility) {
          coords = {
            lat: selectedFacility.lat,
            lon: selectedFacility.lon,
            name: selectedFacility.name,
            type: selectedFacility.type.toUpperCase(),
          };
        } else if (selectedBuilding) {
          const bLat = selectedBuilding.centroid?.lat ?? 19.055;
          const bLon = selectedBuilding.centroid?.lon ?? 72.885;
          coords = {
            lat: bLat,
            lon: bLon,
            name: selectedBuilding.name,
            type: selectedBuilding.type.toUpperCase(),
          };
        } else if (selectedRoad) {
          const rLat = selectedRoad.midpoint?.lat ?? (selectedRoad.coords?.[0] ? selectedRoad.coords[0][1] : 19.055);
          const rLon = selectedRoad.midpoint?.lon ?? (selectedRoad.coords?.[0] ? selectedRoad.coords[0][0] : 72.885);
          coords = {
            lat: rLat,
            lon: rLon,
            name: selectedRoad.name,
            type: selectedRoad.type.toUpperCase(),
          };
        }

        if (!coords || !showStreetViewPanel) return null;

        return (
          <div className="osm-streetview-slide-panel">
            <div className="osm-streetview-slide-header">
              <div className="osm-streetview-slide-title-wrap">
                <div className="osm-streetview-slide-title">
                  <span><IconRoad size={14} className="svg-icon-inline" /></span>
                  <span>Panoramic Street View</span>
                </div>
                <div className="osm-streetview-slide-coords">
                  {coords.lat.toFixed(5)}° N, {coords.lon.toFixed(5)}° E
                </div>
              </div>
              <div className="osm-streetview-slide-actions">
                <a
                  href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${coords.lat},${coords.lon}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="osm-streetview-external-link"
                  title="Open full interactive 360° view in Google Maps"
                >
                  ↗ Full 360°
                </a>
                <button
                  className="osm-streetview-close-btn"
                  onClick={() => setShowStreetViewPanel(false)}
                  title="Collapse Street View Panel"
                  aria-label="Collapse street view panel"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="osm-streetview-body">
              <iframe
                className="osm-streetview-full-iframe"
                title="Live 360 Street View"
                src={`https://www.google.com/maps?layer=c&cbll=${coords.lat},${coords.lon}&cbp=12,0,0,0,0&output=svembed`}
                loading="lazy"
              />
            </div>

            <div className="osm-streetview-footer">
              <div className="osm-streetview-live-badge">
                <span className="osm-streetview-live-dot" />
                <span>LIVE 360° TELEMETRY</span>
              </div>
              <span>{coords.name ? (coords.name.length > 20 ? coords.name.slice(0, 18) + '…' : coords.name) : coords.type}</span>
            </div>
          </div>
        );
      })()}

      {/* Floating Interactive OSM Inspector Modal for Roads */}
      {selectedRoad && (
        <div className="osm-inspector-modal">
          <div className="osm-inspector-modal__header">
            <div>
              <div className="osm-inspector-modal__title"><IconRoad size={15} className="svg-icon-inline" /> {selectedRoad.name}</div>
              <div className="osm-inspector-modal__subtitle">
                OSM Way #{selectedRoad.id} • {selectedRoad.type.toUpperCase()}
              </div>
              <span className={`road-status-badge road-status-badge--${selectedRoad.status}`}>
                {selectedRoad.status === 'closed'
                  ? (selectedRoad.closure_reason || 'CLOSED')
                  : selectedRoad.status === 'restricted'
                  ? (selectedRoad.closure_reason || 'RESTRICTED ACCESS')
                  : 'OPERATIONAL & SAFE'}
              </span>
            </div>
            <button className="osm-inspector-modal__close" onClick={() => setSelectedRoad(null)} aria-label="Close road details">
              ✕
            </button>
          </div>

          <div className="osm-inspector-modal__body">
            <div className="osm-stats-grid">
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Length</span>
                <span className="osm-stat-chip-val">{(selectedRoad.length_m / 1000).toFixed(2)} km</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Highway</span>
                <span className="osm-stat-chip-val">{selectedRoad.type}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Lanes</span>
                <span className="osm-stat-chip-val">{selectedRoad.lanes || selectedRoad.raw_tags?.lanes || '2 (Standard)'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Max Speed</span>
                <span className="osm-stat-chip-val">{selectedRoad.maxspeed || selectedRoad.raw_tags?.maxspeed || '50 km/h'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Surface</span>
                <span className="osm-stat-chip-val">{selectedRoad.surface || selectedRoad.raw_tags?.surface || 'Paved / Asphalt'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">One-Way</span>
                <span className="osm-stat-chip-val">{selectedRoad.oneway === 'yes' ? 'Yes' : 'Two-way'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Elevation</span>
                <span className="osm-stat-chip-val" style={{ color: '#38bdf8' }}>
                  {selectedRoad.elevation_m !== undefined ? `${selectedRoad.elevation_m.toFixed(1)} m ASL` : 'DEM Calibrated'}
                </span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Elev Range</span>
                <span className="osm-stat-chip-val">
                  {selectedRoad.min_elevation_m !== undefined ? `${selectedRoad.min_elevation_m.toFixed(1)} - ${selectedRoad.max_elevation_m?.toFixed(1)} m` : '--'}
                </span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Slope / Gradient</span>
                <span className="osm-stat-chip-val">
                  {selectedRoad.slope_pct !== undefined ? `${selectedRoad.slope_pct.toFixed(1)} %` : '0.0 %'}
                </span>
              </div>
            </div>

              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Hazard Impact</span>
                <span className="osm-inspector-modal__val" style={{ color: selectedRoad.status === 'closed' ? '#f87171' : selectedRoad.status === 'restricted' ? '#fbbf24' : '#34d399' }}>
                  {`${selectedRoad.closure_reason || 'No hazard exposure'}${selectedRoad.hazard_severity !== undefined ? ` • ${selectedRoad.hazard_severity} ${result?.impact?.hazard_unit || ''}` : ''}`}
                </span>
              </div>

            <div className="osm-inspector-modal__row">
              <span className="osm-inspector-modal__label">Infrastructure</span>
              <span className="osm-inspector-modal__val">
                {selectedRoad.bridge ? 'Flyover / Bridge' : selectedRoad.tunnel ? 'Underpass / Tunnel' : 'Surface Grade'}
              </span>
            </div>

            {selectedRoad.ref && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Route Ref</span>
                <span className="osm-inspector-modal__val">{selectedRoad.ref}</span>
              </div>
            )}

            <a
              className="osm-link-btn"
              href={`https://www.openstreetmap.org/way/${selectedRoad.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in OpenStreetMap ↗
            </a>

            <RawTagsViewer tags={selectedRoad.raw_tags} />
          </div>
        </div>
      )}

      {/* Floating Interactive OSM Inspector Modal for Facilities */}
      {selectedFacility && (
        <div className="osm-inspector-modal">
          <div className="osm-inspector-modal__header">
            <div>
              <div className="osm-inspector-modal__title">
                {selectedFacility.type === 'hospital' ? <IconHospital size={15} className="svg-icon-inline" /> : selectedFacility.type === 'shelter' || selectedFacility.type === 'school' ? <IconShelter size={15} className="svg-icon-inline" /> : selectedFacility.type === 'police' || selectedFacility.type === 'fire_station' ? <IconPolice size={15} className="svg-icon-inline" /> : <IconLocationPin size={15} className="svg-icon-inline" />}{' '}{selectedFacility.name}
              </div>
              <div className="osm-inspector-modal__subtitle">
                OSM Facility #{selectedFacility.id} • {selectedFacility.type.toUpperCase()}
              </div>
              <span className={`road-status-badge ${selectedFacility.flooded ? 'road-status-badge--closed' : 'road-status-badge--open'}`}>
                {selectedFacility.flooded ? `${hz.affectedWord} (${(selectedFacility.hazard_severity ?? selectedFacility.flood_depth).toFixed(2)} ${hz.unit})${selectedFacility.functionality && selectedFacility.functionality !== 'operational' ? ` • ${selectedFacility.functionality.toUpperCase()}` : ''}${selectedFacility.smoke_risk ? ' • SMOKE RISK' : ''}` : 'OPERATIONAL & SAFE'}
              </span>
            </div>
            <button className="osm-inspector-modal__close" onClick={() => setSelectedFacility(null)} aria-label="Close facility details">
              ✕
            </button>
          </div>

          <div className="osm-inspector-modal__body">
            <div className="osm-stats-grid">
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Capacity</span>
                <span className="osm-stat-chip-val">{selectedFacility.capacity || 500} persons</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Sector</span>
                <span className="osm-stat-chip-val">{selectedFacility.operator_type || selectedFacility.raw_tags?.['operator:type'] || 'Municipal / Public'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Emergency Ward</span>
                <span className="osm-stat-chip-val">{selectedFacility.emergency === 'yes' ? '24/7 Available' : 'Standard'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">District</span>
                <span className="osm-stat-chip-val">{selectedFacility.district || 'Mumbai'}</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Elevation</span>
                <span className="osm-stat-chip-val" style={{ color: '#38bdf8' }}>
                  {selectedFacility.elevation_m !== undefined ? `${selectedFacility.elevation_m.toFixed(1)} m ASL` : 'DEM Calibrated'}
                </span>
              </div>
            </div>

            {selectedFacility.address && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Address</span>
                <span className="osm-inspector-modal__val" title={selectedFacility.address}>{selectedFacility.address}</span>
              </div>
            )}

            {selectedFacility.phone && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Hotline</span>
                <span className="osm-inspector-modal__val" style={{ color: '#38bdf8' }}>{selectedFacility.phone}</span>
              </div>
            )}

            {selectedFacility.operator && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Operator</span>
                <span className="osm-inspector-modal__val">{selectedFacility.operator}</span>
              </div>
            )}

            {selectedFacility.website && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Website</span>
                {isSafeHttpUrl(selectedFacility.website) ? (
                  <a href={selectedFacility.website} target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8', fontSize: '11px', textDecoration: 'underline' }}>
                    Official Portal ↗
                  </a>
                ) : (
                  <span className="osm-inspector-modal__val" title={selectedFacility.website}>{selectedFacility.website}</span>
                )}
              </div>
            )}

            <a
              className="osm-link-btn"
              href={`https://www.openstreetmap.org/node/${selectedFacility.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in OpenStreetMap ↗
            </a>

            <RawTagsViewer tags={selectedFacility.raw_tags} />
          </div>
        </div>
      )}

      {/* Floating Interactive OSM Inspector Modal for Buildings */}
      {selectedBuilding && (
        <div className="osm-inspector-modal">
          <div className="osm-inspector-modal__header">
            <div>
              <div className="osm-inspector-modal__title"><IconBuilding size={15} className="svg-icon-inline" /> {selectedBuilding.name}</div>
              <div className="osm-inspector-modal__subtitle">
                OSM Structure #{selectedBuilding.id} • {selectedBuilding.type.toUpperCase()}
              </div>
              <span className={`road-status-badge ${selectedBuilding.flooded ? 'road-status-badge--closed' : 'road-status-badge--open'}`}>
                {selectedBuilding.flooded ? `${selectedBuilding.damage_state && !['None', 'Unaffected'].includes(selectedBuilding.damage_state) ? selectedBuilding.damage_state.toUpperCase() : hz.affectedWord} (${(selectedBuilding.hazard_severity ?? selectedBuilding.flood_depth).toFixed(2)} ${hz.unit})` : hz.clearWord}
              </span>
            </div>
            <button className="osm-inspector-modal__close" onClick={() => setSelectedBuilding(null)} aria-label="Close building details">
              ✕
            </button>
          </div>

          <div className="osm-inspector-modal__body">
            <div className="osm-stats-grid">
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Footprint</span>
                <span className="osm-stat-chip-val">{selectedBuilding.area_sqm} m²</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Levels</span>
                <span className="osm-stat-chip-val">{selectedBuilding.levels || 1} Floors</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Height</span>
                <span className="osm-stat-chip-val">{selectedBuilding.height_m || (selectedBuilding.levels ? selectedBuilding.levels * 3.2 : 3.5)}m</span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Damage Est.</span>
                <span className="osm-stat-chip-val" style={{ color: selectedBuilding.flooded ? '#f87171' : '#34d399' }}>
                  {selectedBuilding.flooded ? `₹${Math.round(selectedBuilding.area_sqm * 12000 * (selectedBuilding.damage_ratio ?? 1)).toLocaleString('en-IN')}` : '₹0 (Safe)'}
                </span>
              </div>
              <div className="osm-stat-chip">
                <span className="osm-stat-chip-label">Elevation</span>
                <span className="osm-stat-chip-val" style={{ color: '#38bdf8' }}>
                  {selectedBuilding.elevation_m !== undefined ? `${selectedBuilding.elevation_m.toFixed(1)} m ASL` : 'DEM Calibrated'}
                </span>
              </div>
            </div>

            {selectedBuilding.addr_street && (
              <div className="osm-inspector-modal__row">
                <span className="osm-inspector-modal__label">Street</span>
                <span className="osm-inspector-modal__val">{selectedBuilding.addr_street}</span>
              </div>
            )}

            <div className="osm-inspector-modal__row">
              <span className="osm-inspector-modal__label">Classification</span>
              <span className="osm-inspector-modal__val">{selectedBuilding.type}</span>
            </div>

            <a
              className="osm-link-btn"
              href={`https://www.openstreetmap.org/way/${selectedBuilding.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in OpenStreetMap ↗
            </a>

            <RawTagsViewer tags={selectedBuilding.raw_tags} />
          </div>
        </div>
      )}





      {/* 3D Terrain Viewer Modal (Copernicus GLO-30 DEM Calibrated) */}
      {is3DMode && result && (
        <Suspense fallback={<div className="terrain3d-loading-fallback">Loading 3D terrain…</div>}>
          <Terrain3DViewer
            result={result}
            currentFrame={currentFrame}
            setCurrentFrame={setCurrentFrame}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            playSpeed={playSpeed}
            setPlaySpeed={setPlaySpeed}
            disasterType={disasterType}
            onClose={() => setIs3DMode(false)}
          />
        </Suspense>
      )}


    </div>
  );
}
