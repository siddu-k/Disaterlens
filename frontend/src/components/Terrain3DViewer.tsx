import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { SimulationResult, RoadFeature } from '../types';
import { IconPlay, IconPause } from './Icons';

interface Terrain3DViewerProps {
  result: SimulationResult;
  currentFrame: number;
  setCurrentFrame?: (frame: number) => void;
  isPlaying?: boolean;
  setIsPlaying?: (playing: boolean) => void;
  playSpeed?: number;
  setPlaySpeed?: (speed: number) => void;
  disasterType?: string;
  onClose: () => void;
}

// ─── Scientific Color Ramps & Metric Normalizers for All 5 Hazards ───

// Hazard-specific color ramp for 2D snapshots and UI representations
function getHazardColor(disaster: string, norm: number, alpha = 0.75): string {
  if (disaster === 'wildfire') {
    // Glowing flame palette: red -> fiery orange -> bright yellow core
    if (norm > 0.65) return `rgba(254, 240, 138, ${Math.min(0.95, alpha + 0.15).toFixed(2)})`;
    if (norm > 0.3) return `rgba(249, 115, 22, ${alpha.toFixed(2)})`;
    return `rgba(220, 38, 38, ${Math.max(0.35, alpha - 0.1).toFixed(2)})`;
  }
  if (disaster === 'earthquake') {
    // Seismic ground motion: golden yellow -> amber -> deep seismic crimson
    if (norm > 0.7) return `rgba(239, 68, 68, ${Math.min(0.95, alpha + 0.15).toFixed(2)})`;
    if (norm > 0.35) return `rgba(245, 158, 11, ${alpha.toFixed(2)})`;
    return `rgba(234, 179, 8, ${Math.max(0.35, alpha - 0.15).toFixed(2)})`;
  }
  if (disaster === 'cyclone') {
    // Gale winds: cyan -> electric blue -> violet / magenta core
    if (norm > 0.7) return `rgba(168, 85, 247, ${Math.min(0.95, alpha + 0.15).toFixed(2)})`;
    if (norm > 0.35) return `rgba(14, 165, 233, ${alpha.toFixed(2)})`;
    return `rgba(6, 182, 212, ${Math.max(0.35, alpha - 0.15).toFixed(2)})`;
  }
  if (disaster === 'landslide') {
    // Mud & debris flow: golden ochre -> terracotta -> deep chocolate mud
    if (norm > 0.6) return `rgba(120, 53, 15, ${Math.min(0.95, alpha + 0.15).toFixed(2)})`;
    if (norm > 0.25) return `rgba(180, 83, 9, ${alpha.toFixed(2)})`;
    return `rgba(217, 119, 6, ${Math.max(0.35, alpha - 0.15).toFixed(2)})`;
  }
  // flood: shallow crystal turquoise azure -> deep cobalt indigo
  if (norm > 0.6) return `rgba(30, 58, 138, ${Math.min(0.92, alpha + 0.15).toFixed(2)})`;
  if (norm > 0.25) return `rgba(14, 165, 233, ${alpha.toFixed(2)})`;
  return `rgba(56, 189, 248, ${Math.max(0.35, alpha - 0.15).toFixed(2)})`;
}

// Determines if a cell value represents an active, impactful hazard
function isCellHazardActive(disaster: string, val: number, peak: number): boolean {
  if (val <= 0.005) return false;
  if (disaster === 'wildfire') return val > 0.04;
  if (disaster === 'earthquake') return val > (peak > 4 ? 3.0 : peak * 0.12);
  if (disaster === 'cyclone') return val > (peak > 80 ? 62.0 : 40.0);
  if (disaster === 'landslide') return val > 0.12;
  return val > 0.03; // flood depth meters
}

// Compute normalized 0.0 - 1.0 hazard intensity for colors and physics
function getNormHazard(disaster: string, val: number, peak: number): number {
  if (val <= 0.005) return 0;
  if (disaster === 'earthquake') {
    const minM = peak > 4 ? 3.0 : 0;
    return Math.min(1.0, Math.max(0, (val - minM) / Math.max(1, peak - minM)));
  }
  if (disaster === 'cyclone') {
    const minW = peak > 80 ? 62.0 : 35.0;
    return Math.min(1.0, Math.max(0, (val - minW) / Math.max(20, peak - minW)));
  }
  if (disaster === 'wildfire') {
    return Math.min(1.0, Math.max(0, val / Math.max(0.1, peak)));
  }
  if (disaster === 'landslide') {
    return Math.min(1.0, Math.max(0, val / Math.max(0.15, peak)));
  }
  return Math.min(1.0, Math.max(0, val / Math.max(0.5, peak)));
}

// ─── 3D Tile Hit-Testing & Canvas Affine Texture Mapping ───
function isPointInQuad(
  px: number,
  py: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number }
): boolean {
  const pts = [p0, p1, p2, p3];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawTriangleTexture(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x0: number, y0: number, u0: number, v0: number,
  x1: number, y1: number, u1: number, v1: number,
  x2: number, y2: number, u2: number, v2: number
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();

  const delta = u0 * (v1 - v2) - v0 * (u1 - u2) + (u1 * v2 - u2 * v1);
  if (Math.abs(delta) < 0.0001) {
    ctx.restore();
    return;
  }
  const deltaA = x0 * (v1 - v2) - v0 * (x1 - x2) + (x1 * v2 - x2 * v1);
  const deltaB = u0 * (x1 - x2) - x0 * (u1 - u2) + (u1 * x2 - u2 * x1);
  const deltaC = u0 * (v1 * x2 - v2 * x1) - v0 * (u1 * x2 - u2 * x1) + x0 * (u1 * v2 - u2 * v1);
  const deltaD = y0 * (v1 - v2) - v0 * (y1 - y2) + (y1 * v2 - y2 * v1);
  const deltaE = u0 * (y1 - y2) - y0 * (u1 - u2) + (u1 * y2 - u2 * y1);
  const deltaF = u0 * (v1 * y2 - v2 * y1) - v0 * (u1 * y2 - u2 * y1) + y0 * (u1 * v2 - u2 * v1);

  ctx.transform(
    deltaA / delta,
    deltaD / delta,
    deltaB / delta,
    deltaE / delta,
    deltaC / delta,
    deltaF / delta
  );
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawTexturedQuad(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  p00: { x: number; y: number },
  p10: { x: number; y: number },
  p11: { x: number; y: number },
  p01: { x: number; y: number },
  u0 = 0,
  v0 = 0,
  u1 = 1,
  v1 = 1
) {
  const w = img.naturalWidth || img.width || 256;
  const h = img.naturalHeight || img.height || 256;
  const sx0 = u0 * w;
  const sy0 = v0 * h;
  const sx1 = u1 * w;
  const sy1 = v1 * h;
  drawTriangleTexture(ctx, img, p00.x, p00.y, sx0, sy0, p10.x, p10.y, sx1, sy0, p01.x, p01.y, sx0, sy1);
  drawTriangleTexture(ctx, img, p11.x, p11.y, sx1, sy1, p10.x, p10.y, sx1, sy0, p01.x, p01.y, sx0, sy1);
}

// ─── Tactical Satellite View of Selected Tile (Cropped from full AOI Image) ───
function TileSatelliteCanvas({
  aoiSatImg,
  selectedTileData,
  cols,
  rows,
}: {
  aoiSatImg: HTMLImageElement | null;
  selectedTileData: any;
  cols: number;
  rows: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 320;
    const H = 160;
    ctx.clearRect(0, 0, W, H);

    const { r, c } = selectedTileData;
    const u0 = c / Math.max(1, cols - 1);
    const u1 = (c + 1) / Math.max(1, cols - 1);
    const v0 = r / Math.max(1, rows - 1);
    const v1 = (r + 1) / Math.max(1, rows - 1);

    if (aoiSatImg && aoiSatImg.complete && aoiSatImg.naturalWidth > 0) {
      const iw = aoiSatImg.naturalWidth;
      const ih = aoiSatImg.naturalHeight;
      const sx = u0 * iw;
      const sy = v0 * ih;
      const sw = Math.max(1, (u1 - u0) * iw);
      const sh = Math.max(1, (v1 - v0) * ih);
      ctx.drawImage(aoiSatImg, sx, sy, sw, sh, 0, 0, W, H);
    } else {
      // Sleek radar acquisition grid
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y < H; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('🛰️ ACQUIRING OPTICAL SATELLITE...', W / 2, H / 2);
    }

    // Optical tactical crosshair in center
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 12, H / 2);
    ctx.lineTo(W / 2 + 12, H / 2);
    ctx.moveTo(W / 2, H / 2 - 12);
    ctx.lineTo(W / 2, H / 2 + 12);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2);
    ctx.stroke();
  }, [aoiSatImg, selectedTileData, cols, rows]);

  return <canvas ref={canvasRef} width={320} height={160} className="terrain3d-sat-card-img" />;
}

// ─── Static 2D Reference Snapshot of Selected Box ───
function AreaSnapshot({
  result,
  currentFrame,
  hazardType,
}: {
  result: SimulationResult;
  currentFrame: number;
  hazardType: string;
}) {
  const snapRef = useRef<HTMLCanvasElement>(null);

  const box = result.aoi_bbox || result.bbox;
  const aspect = (box.north - box.south) / Math.max(0.0001, box.east - box.west);
  const W = 640;
  const H = Math.round(Math.min(620, Math.max(300, W * aspect)));

  useEffect(() => {
    const canvas = snapRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sim = result.simulation;
    ctx.fillStyle = '#0a0f1d';
    ctx.fillRect(0, 0, W, H);

    const latSpan = Math.max(0.0001, box.north - box.south);
    const lonSpan = Math.max(0.0001, box.east - box.west);
    const X = (lon: number) => ((lon - box.west) / lonSpan) * W;
    const Y = (lat: number) => ((box.north - lat) / latSpan) * H;

    // Hazard frame cells (mapped by lat/lon from the sim grid)
    const frames = sim.frames || [];
    const grid = frames[Math.min(Math.floor(currentFrame), Math.max(0, frames.length - 1))] || [];
    const rows = sim.rows || grid.length;
    const cols = sim.cols || (grid[0] ? grid[0].length : 0);
    const sb = result.bbox;
    let peak = 0;
    grid.forEach((row) => row.forEach((v) => { if (v > peak) peak = v; }));
    peak = peak || 1;

    const cw = W / Math.max(1, cols);
    const ch = H / Math.max(1, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r]?.[c] ?? 0;
        if (!isCellHazardActive(hazardType, v, peak)) continue;
        const lat = sb.north - ((r + 0.5) / rows) * (sb.north - sb.south);
        const lon = sb.west + ((c + 0.5) / cols) * (sb.east - sb.west);
        const x = X(lon);
        const y = Y(lat);
        if (x < -cw || x > W + cw || y < -ch || y > H + ch) continue;

        const norm = getNormHazard(hazardType, v, peak);
        ctx.fillStyle = getHazardColor(hazardType, norm, 0.25 + 0.55 * norm);
        ctx.fillRect(x - cw / 2, y - ch / 2, cw + 0.5, ch + 0.5);
      }
    }

    // Roads colored by real-time current frame hazard intensity (green at 0h baseline)
    (result.geodata?.roads || []).forEach((road) => {
      if (!road.coords || road.coords.length < 2) return;
      ctx.beginPath();
      let maxH = 0;
      road.coords.forEach((pt, i) => {
        const x = X(pt[0]);
        const y = Y(pt[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        const r = Math.min(rows - 1, Math.max(0, Math.floor(((sb.north - pt[1]) / (sb.north - sb.south)) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(((pt[0] - sb.west) / (sb.east - sb.west)) * cols)));
        const w = grid[r]?.[c] ?? 0;
        if (w > maxH) maxH = w;
      });

      const isRoadImp = isCellHazardActive(hazardType, maxH, peak);
      const norm = getNormHazard(hazardType, maxH, peak);

      ctx.strokeStyle =
        isRoadImp
          ? norm > 0.5
            ? '#ef4444'
            : '#f59e0b'
          : 'rgba(52, 211, 153, 0.85)';
      ctx.lineWidth = isRoadImp && norm > 0.5 ? 2.0 : 1.3;
      ctx.stroke();
    });

    // Buildings as dots (alert color only when hazard actively reaches them in this frame)
    const buildings = result.impact?.buildings || result.geodata?.buildings || [];
    buildings.forEach((bldg: any) => {
      const cent = bldg.centroid;
      if (!cent) return;
      const r = Math.min(rows - 1, Math.max(0, Math.floor(((sb.north - cent.lat) / (sb.north - sb.south)) * rows)));
      const c = Math.min(cols - 1, Math.max(0, Math.floor(((cent.lon - sb.west) / (sb.east - sb.west)) * cols)));
      const w = grid[r]?.[c] ?? 0;
      const isImp = isCellHazardActive(hazardType, w, peak);
      ctx.fillStyle = isImp ? '#ef4444' : 'rgba(148, 163, 184, 0.6)';
      ctx.fillRect(X(cent.lon) - 1, Y(cent.lat) - 1, isImp ? 3 : 2, isImp ? 3 : 2);
    });

    // Facilities as squares
    (result.impact?.facilities || []).forEach((f: any) => {
      ctx.fillStyle = f.type === 'hospital' ? '#ef4444' : f.type === 'shelter' ? '#34d399' : '#38bdf8';
      ctx.fillRect(X(f.lon) - 2.5, Y(f.lat) - 2.5, 5, 5);
    });

    // Selected-box outline
    ctx.strokeStyle = '#38bdf8';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.setLineDash([]);
  }, [result, currentFrame, hazardType, box, W, H]);

  return <canvas ref={snapRef} width={W} height={H} className="terrain3d-snapshot-canvas" />;
}

// ─── Satellite 2D View with Real-Time Hazard Simulation Overlay ───
function SatelliteAreaSnapshot({
  result,
  currentFrame,
  hazardType,
}: {
  result: SimulationResult;
  currentFrame: number;
  hazardType: string;
}) {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  const box = result.aoi_bbox || result.bbox;
  const aspect = (box.north - box.south) / Math.max(0.0001, box.east - box.west);
  const W = 640;
  const H = Math.round(Math.min(620, Math.max(300, W * aspect)));

  // ArcGIS World Imagery high-resolution satellite export URL for the exact AOI bounding box
  const satUrl = useMemo(() => {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${box.west},${box.south},${box.east},${box.north}&bboxSR=4326&size=${W},${H}&imageSR=4326&format=jpg&f=image`;
  }, [box.west, box.south, box.east, box.north, W, H]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, W, H);

    const latSpan = Math.max(0.0001, box.north - box.south);
    const lonSpan = Math.max(0.0001, box.east - box.west);
    const X = (lon: number) => ((lon - box.west) / lonSpan) * W;
    const Y = (lat: number) => ((box.north - lat) / latSpan) * H;

    const sim = result.simulation;
    const frames = sim.frames || [];
    const grid = frames[Math.min(Math.floor(currentFrame), Math.max(0, frames.length - 1))] || [];
    const rows = sim.rows || grid.length;
    const cols = sim.cols || (grid[0] ? grid[0].length : 0);
    const sb = result.bbox;

    let peak = 0;
    grid.forEach((row) => row.forEach((v) => { if (v > peak) peak = v; }));
    peak = peak || 1;

    // Draw hazard overlay on satellite with hazard-specific color ramps
    const cw = W / Math.max(1, cols);
    const ch = H / Math.max(1, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r]?.[c] ?? 0;
        if (!isCellHazardActive(hazardType, v, peak)) continue;
        const lat = sb.north - ((r + 0.5) / rows) * (sb.north - sb.south);
        const lon = sb.west + ((c + 0.5) / cols) * (sb.east - sb.west);
        const x = X(lon);
        const y = Y(lat);
        if (x < -cw || x > W + cw || y < -ch || y > H + ch) continue;

        const norm = getNormHazard(hazardType, v, peak);
        const depthAlpha = Math.min(0.78, 0.32 + 0.44 * norm);
        ctx.fillStyle = getHazardColor(hazardType, norm, depthAlpha);
        ctx.fillRect(x - cw / 2, y - ch / 2, cw + 0.5, ch + 0.5);

        // Water or hazard edge contour
        if (norm > 0.35) {
          ctx.strokeStyle =
            hazardType === 'wildfire'
              ? 'rgba(254, 240, 138, 0.4)'
              : hazardType === 'earthquake'
              ? 'rgba(239, 68, 68, 0.45)'
              : hazardType === 'cyclone'
              ? 'rgba(168, 85, 247, 0.4)'
              : hazardType === 'landslide'
              ? 'rgba(120, 53, 15, 0.45)'
              : 'rgba(224, 242, 254, 0.45)';
          ctx.lineWidth = 0.6;
          ctx.strokeRect(x - cw / 2, y - ch / 2, cw + 0.5, ch + 0.5);
        }
      }
    }

    // Roads overlaid on satellite: colored dynamically by current frame hazard level (all green at 0h)
    (result.geodata?.roads || []).forEach((road) => {
      if (!road.coords || road.coords.length < 2) return;
      ctx.beginPath();
      let maxH = 0;
      road.coords.forEach((pt, i) => {
        const x = X(pt[0]);
        const y = Y(pt[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        const r = Math.min(rows - 1, Math.max(0, Math.floor(((sb.north - pt[1]) / (sb.north - sb.south)) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(((pt[0] - sb.west) / (sb.east - sb.west)) * cols)));
        const w = grid[r]?.[c] ?? 0;
        if (w > maxH) maxH = w;
      });

      const isRoadImp = isCellHazardActive(hazardType, maxH, peak);
      const norm = getNormHazard(hazardType, maxH, peak);

      ctx.strokeStyle =
        isRoadImp
          ? norm > 0.5
            ? '#ef4444'
            : '#f59e0b'
          : 'rgba(52, 211, 153, 0.85)';
      ctx.lineWidth = isRoadImp && norm > 0.5 ? 2.0 : 1.4;
      ctx.stroke();
    });

    // Facilities on satellite
    (result.impact?.facilities || []).forEach((f: any) => {
      const fx = X(f.lon);
      const fy = Y(f.lat);
      ctx.fillStyle = f.type === 'hospital' ? '#ef4444' : f.type === 'shelter' ? '#34d399' : '#38bdf8';
      ctx.beginPath();
      ctx.arc(fx, fy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Selected-box outline
    ctx.strokeStyle = '#38bdf8';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.setLineDash([]);
  }, [result, currentFrame, hazardType, box, W, H]);

  return (
    <div className="terrain3d-satellite-container" style={{ position: 'relative', width: '100%', borderRadius: 8, overflow: 'hidden', background: '#0a0f1d' }}>
      {!imgLoaded && !imgError && (
        <div style={{ padding: '28px 12px', textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
          Loading ArcGIS World Imagery…
        </div>
      )}
      <img
        src={satUrl}
        alt="ArcGIS Satellite Imagery"
        className="terrain3d-snapshot-canvas"
        style={{
          width: '100%',
          display: imgLoaded ? 'block' : 'none',
          borderRadius: 8,
        }}
        onLoad={() => setImgLoaded(true)}
        onError={() => setImgError(true)}
      />
      {imgLoaded && (
        <canvas
          ref={overlayRef}
          width={W}
          height={H}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            borderRadius: 8,
          }}
        />
      )}
      {imgError && (
        <div style={{ padding: '20px 12px', textAlign: 'center', color: '#f87171', fontSize: 11, background: 'rgba(239, 68, 68, 0.1)', borderRadius: 8 }}>
          Satellite imagery unavailable offline.
        </div>
      )}
    </div>
  );
}

export default function Terrain3DViewer({
  result,
  currentFrame,
  setCurrentFrame,
  isPlaying,
  setIsPlaying,
  playSpeed = 1,
  setPlaySpeed,
  disasterType = 'flood',
  onClose,
}: Terrain3DViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Detect active hazard type
  const hazardType = (result.simulation?.disaster_type || disasterType || 'flood').toLowerCase();

  // Free-orbit camera: yaw wraps 360°, pitch 0° (horizon) -> 90° (top-down)
  const [yaw, setYaw] = useState<number>(45); // degrees
  const [pitch, setPitch] = useState<number>(35); // degrees
  const [zoom, setZoom] = useState<number>(1.85);
  const [zExaggeration, setZExaggeration] = useState<number>(1.0);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [show2DReference, setShow2DReference] = useState<boolean>(false);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const draggingRef = useRef<boolean>(false);
  const lastMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<number | null>(null);

  // ─── Real-Time Continuous Physics & Timeline Simulation State ───
  const [animFrame, setAnimFrame] = useState<number>(currentFrame);
  const [localPlaying, setLocalPlaying] = useState<boolean>(isPlaying ?? false);
  const [localSpeed, setLocalSpeed] = useState<number>(playSpeed ?? 1);
  const [physicsEnabled, setPhysicsEnabled] = useState<boolean>(true);
  const [wavePhase, setWavePhase] = useState<number>(0);
  const [tileNumberMode, setTileNumberMode] = useState<'id' | 'elev' | 'hazard' | 'off'>('id');
  const [showBuildings, setShowBuildings] = useState<boolean>(true);

  // ─── 3D Selected Tile & Floating Satellite Hover State ───
  const [selectedTile, setSelectedTile] = useState<{ r: number; c: number } | null>(null);
  const [hoveredTile, setHoveredTile] = useState<{ r: number; c: number } | null>(null);
  const satelliteHeight = 85;
  const [renderNonce, setRenderNonce] = useState<number>(0);

  const dragStartPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragModeRef = useRef<'orbit' | 'zoom'>('orbit');
  const hasMovedDrag = useRef<boolean>(false);
  const screenQuadsRef = useRef<Array<{
    r: number;
    c: number;
    depth: number;
    p00: { x: number; y: number };
    p10: { x: number; y: number };
    p11: { x: number; y: number };
    p01: { x: number; y: number };
  }>>([]);
  const tileImgRef = useRef<HTMLImageElement | null>(null);
  const floatingCardRef = useRef<HTMLDivElement | null>(null);

  const animFrameRef = useRef<number>(currentFrame);
  animFrameRef.current = animFrame;
  const isPlayingRef = useRef<boolean>(localPlaying);
  isPlayingRef.current = localPlaying;
  const speedRef = useRef<number>(localSpeed);
  speedRef.current = localSpeed;
  const lastTimeRef = useRef<number>(performance.now());
  const rafRef = useRef<number | null>(null);

  const sim = result.simulation;
  const frames = sim.frames || [];
  const totalFrames = Math.max(1, frames.length);
  const totalSimulationHours = sim.total_time_hours || 24;
  const timeUnit = sim.time_unit || (hazardType === 'earthquake' ? 'seconds' : hazardType === 'landslide' ? 'minutes' : 'hours');
  const totalSimulationTime = sim.total_time ?? (
    hazardType === 'earthquake' ? 90 : hazardType === 'landslide' ? 15 : totalSimulationHours
  );
  const timestepLabels = sim.timestep_labels || [];

  // Global peak across all frames for normalized intensity calculations
  const peakVal = useMemo(() => {
    let p = 0;
    frames.forEach((f) => {
      if (!f) return;
      f.forEach((row) => {
        if (!row) return;
        row.forEach((v) => {
          if (v > p) p = v;
        });
      });
    });
    return p || 1;
  }, [frames]);

  // Sync external currentFrame if not playing locally
  useEffect(() => {
    if (!localPlaying) {
      setAnimFrame(currentFrame);
    }
  }, [currentFrame, localPlaying]);

  // Sync external isPlaying
  useEffect(() => {
    if (isPlaying !== undefined) {
      setLocalPlaying(isPlaying);
    }
  }, [isPlaying]);

  // Sync external playSpeed
  useEffect(() => {
    if (playSpeed !== undefined) {
      setLocalSpeed(playSpeed);
    }
  }, [playSpeed]);

  // 60 FPS Real-Time Physics & Animation Loop
  useEffect(() => {
    let active = true;
    lastTimeRef.current = performance.now();

    const loop = (now: number) => {
      if (!active) return;
      const dt = Math.min(0.08, (now - lastTimeRef.current) / 1000);
      lastTimeRef.current = now;

      // Real physical progression of wave/flicker/wind phase
      setWavePhase((p) => (p + dt * 3.2) % (Math.PI * 200));

      if (isPlayingRef.current) {
        const total = Math.max(1, totalFrames - 1);
        const playbackDurationSec = timeUnit === 'seconds' ? 6.5 : timeUnit === 'minutes' ? 7.5 : Math.max(5, totalSimulationHours * 0.4);
        const rate = (total / playbackDurationSec) * speedRef.current;
        let next = animFrameRef.current + dt * rate;
        if (next >= total) {
          next = 0;
        }
        setAnimFrame(next);
        setCurrentFrame?.(Math.round(next));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [totalFrames, totalSimulationHours, setCurrentFrame]);

  // Timeline scrubber handle
  const handleScrub = useCallback((val: number) => {
    setAnimFrame(val);
    setCurrentFrame?.(Math.round(val));
    if (localPlaying) {
      setLocalPlaying(false);
      setIsPlaying?.(false);
    }
  }, [localPlaying, setCurrentFrame, setIsPlaying]);

  const togglePlay = useCallback(() => {
    const next = !localPlaying;
    setLocalPlaying(next);
    setIsPlaying?.(next);
  }, [localPlaying, setIsPlaying]);

  // Auto-resize observer
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    };
    updateSize();
    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const resetCamera = () => {
    setYaw(45);
    setPitch(35);
    setZoom(1.85);
    setZExaggeration(1.0);
  };

  const elev = result.elevation;
  const rows = elev?.rows || sim.rows || 15;
  const cols = elev?.cols || sim.cols || 17;
  const minElev = elev?.min_elevation ?? 0;
  const maxElev = elev?.max_elevation ?? 50;

  // Elevation grid
  const elevGrid: number[][] = useMemo(() => {
    if (elev?.grid && elev.grid.length > 0) return elev.grid;
    const grid: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const v = r / (rows - 1);
        const val = minElev + (maxElev - minElev) * (0.3 + 0.7 * Math.sin(u * Math.PI) * Math.cos(v * Math.PI));
        row.push(val);
      }
      grid.push(row);
    }
    return grid;
  }, [elev, rows, cols, minElev, maxElev]);

  // Continuous cubic-interpolated physical hazard grid at the exact sub-frame timestamp
  const { currentHazardGrid, nextHazardGrid, subFraction } = useMemo(() => {
    if (frames.length === 0) return { currentHazardGrid: [], nextHazardGrid: [], subFraction: 0 };
    const fA = Math.min(totalFrames - 1, Math.max(0, Math.floor(animFrame)));
    const fB = Math.min(totalFrames - 1, fA + 1);
    const alpha = Math.max(0, Math.min(1, animFrame - fA));
    // Smooth cubic Hermite interpolation
    const smoothAlpha = alpha * alpha * (3 - 2 * alpha);
    return {
      currentHazardGrid: frames[fA] || [],
      nextHazardGrid: frames[fB] || frames[fA] || [],
      subFraction: smoothAlpha,
    };
  }, [frames, totalFrames, animFrame]);

  // Preload full AOI satellite image once (guaranteed valid bbox, zero 500 errors)
  const aoiBox = result.aoi_bbox || result.bbox;
  const aoiSatUrl = useMemo(() => {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${aoiBox.west},${aoiBox.south},${aoiBox.east},${aoiBox.north}&bboxSR=4326&size=800,800&imageSR=4326&format=jpg&f=image`;
  }, [aoiBox.west, aoiBox.south, aoiBox.east, aoiBox.north]);

  const [aoiSatImg, setAoiSatImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = aoiSatUrl;
    img.onload = () => {
      setAoiSatImg(img);
      setRenderNonce((n) => n + 1);
    };
    img.onerror = () => {
      // Gracefully handled by fallback radar canvas
    };
  }, [aoiSatUrl]);

  // Derived telemetry data for selected tile
  const selectedTileData = useMemo(() => {
    if (!selectedTile) return null;
    const { r, c } = selectedTile;
    if (r < 0 || r >= rows - 1 || c < 0 || c >= cols - 1) return null;
    const u0 = c / Math.max(1, cols - 1);
    const u1 = (c + 1) / Math.max(1, cols - 1);
    const v0 = r / Math.max(1, rows - 1);
    const v1 = (r + 1) / Math.max(1, rows - 1);
    const b = result.bbox;
    const tileWest = b.west + u0 * (b.east - b.west);
    const tileEast = b.west + u1 * (b.east - b.west);
    const tileNorth = b.north - v0 * (b.north - b.south);
    const tileSouth = b.north - v1 * (b.north - b.south);
    const tileLat = (tileNorth + tileSouth) / 2;
    const tileLon = (tileWest + tileEast) / 2;

    const e00 = elevGrid[r]?.[c] ?? minElev;
    const e10 = elevGrid[r]?.[c + 1] ?? minElev;
    const e11 = elevGrid[r + 1]?.[c + 1] ?? minElev;
    const e01 = elevGrid[r + 1]?.[c] ?? minElev;
    const avgElev = (e00 + e10 + e11 + e01) / 4;

    const wA = currentHazardGrid[r]?.[c] ?? 0;
    const wB = nextHazardGrid[r]?.[c] ?? wA;
    const avgHazard = wA + (wB - wA) * subFraction;
    const normH = getNormHazard(hazardType, avgHazard, peakVal);

    const tileId = r * (cols - 1) + c + 1;

    return {
      r,
      c,
      tileId,
      tileWest,
      tileEast,
      tileNorth,
      tileSouth,
      tileLat,
      tileLon,
      avgElev,
      avgHazard,
      normH,
    };
  }, [selectedTile, cols, rows, result.bbox, elevGrid, minElev, currentHazardGrid, nextHazardGrid, subFraction, hazardType, peakVal]);

  // Render 3D Canvas Engine with Hazard-Specific Real-Time Physics & Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set high-DPI canvas
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    // Background gradient: Atmospheric twilight GIS command center
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    if (hazardType === 'wildfire') {
      bgGrad.addColorStop(0, '#0f0a0a');
      bgGrad.addColorStop(0.5, '#190d0b');
      bgGrad.addColorStop(1, '#080505');
    } else if (hazardType === 'earthquake') {
      bgGrad.addColorStop(0, '#0c0b11');
      bgGrad.addColorStop(0.5, '#16111e');
      bgGrad.addColorStop(1, '#07060a');
    } else {
      bgGrad.addColorStop(0, '#070b16');
      bgGrad.addColorStop(0.5, '#0b1428');
      bgGrad.addColorStop(1, '#050811');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 3D Projection Math Setup
    const radYaw = (yaw * Math.PI) / 180;
    const radPitch = (pitch * Math.PI) / 180;
    const cosY = Math.cos(radYaw);
    const sinY = Math.sin(radYaw);
    const cosP = Math.cos(radPitch);
    const sinP = Math.sin(radPitch);

    const elevSpan = Math.max(1, maxElev - minElev);
    const centerX = width / 2;
    const centerY = height / 2 + 10;
    const baseScale = Math.min(width, height) * 0.52 * zoom;

    // Project 3D point (u, v in [0, 1], zMeters) into 2D screen coordinates
    const project = (u: number, v: number, zMeters: number) => {
      const nx = (u - 0.5) * 2;
      const ny = (v - 0.5) * 2;
      const normZ = ((zMeters - minElev) / elevSpan) * 0.55 * zExaggeration;

      // Rotate around Z axis (yaw)
      const rx = nx * cosY - ny * sinY;
      const ry = nx * sinY + ny * cosY;
      const rz = normZ;

      // Rotate around X axis (pitch)
      const px = rx;
      const py = ry * cosP - rz * sinP;
      const pz = ry * sinP + rz * cosP + 3.2; // camera distance

      const screenX = centerX + (px / pz) * baseScale;
      const screenY = centerY + (py / pz) * baseScale;
      return { x: screenX, y: screenY, depth: pz };
    };

    // Color mapper: elevation bands with directional slope shading
    const getTerrainColor = (elevVal: number, slopeShade = 1.0) => {
      const t = Math.min(1.0, Math.max(0.0, (elevVal - minElev) / elevSpan));
      let r = 30, g = 58, b = 138;
      if (t < 0.15) {
        r = 16; g = 80; b = 85;
      } else if (t < 0.35) {
        r = 34; g = 139; b = 90;
      } else if (t < 0.65) {
        r = 160; g = 140; b = 45;
      } else if (t < 0.85) {
        r = 180; g = 100; b = 40;
      } else {
        r = 210; g = 190; b = 175;
      }
      r = Math.min(255, Math.max(0, Math.round(r * slopeShade)));
      g = Math.min(255, Math.max(0, Math.round(g * slopeShade)));
      b = Math.min(255, Math.max(0, Math.round(b * slopeShade)));
      return `rgb(${r}, ${g}, ${b})`;
    };

    // Extract Wildfire physical simulation metadata
    const wfSimMeta = (result.simulation as any)?.metadata || {};
    const wfWindDir = Number(wfSimMeta.wind_direction_deg ?? 135);
    const wfWindSpeed = Number(wfSimMeta.wind_speed_kmh ?? 25);
    const wfDirRad = (wfWindDir * Math.PI) / 180;
    const wfDownwindU = Math.sin(wfDirRad);
    const wfDownwindV = -Math.cos(wfDirRad);
    const wfLeanMagnitude = Math.min(0.045, 0.012 + (wfWindSpeed / 100) * 0.035);

    // Build mesh quads with depth sorting for correct 3D occlusion
    const quads: Array<{ r: number; c: number; depth: number }> = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const uMid = (c + 0.5) / (cols - 1);
        const vMid = (r + 0.5) / (rows - 1);
        const eMid = (
          (elevGrid[r]?.[c] ?? minElev) +
          (elevGrid[r]?.[c + 1] ?? minElev) +
          (elevGrid[r + 1]?.[c + 1] ?? minElev) +
          (elevGrid[r + 1]?.[c] ?? minElev)
        ) / 4;
        const pt = project(uMid, vMid, eMid);
        quads.push({ r, c, depth: pt.depth });
      }
    }

    // Sort back-to-front (largest depth rendered first)
    quads.sort((a, b) => b.depth - a.depth);

    // Cache projected quad corners for mouse hit-testing (front-to-back order)
    screenQuadsRef.current = quads.slice().reverse().map(({ r, c, depth }) => {
      const u0 = c / (cols - 1);
      const u1 = (c + 1) / (cols - 1);
      const v0 = r / (rows - 1);
      const v1 = (r + 1) / (rows - 1);
      const e00 = elevGrid[r]?.[c] ?? minElev;
      const e10 = elevGrid[r]?.[c + 1] ?? minElev;
      const e11 = elevGrid[r + 1]?.[c + 1] ?? minElev;
      const e01 = elevGrid[r + 1]?.[c] ?? minElev;
      return {
        r,
        c,
        depth,
        p00: project(u0, v0, e00),
        p10: project(u1, v0, e10),
        p11: project(u1, v1, e11),
        p01: project(u0, v1, e01),
      };
    });

    // Dynamic wave perturbation function (hydrodynamic waves for flood)
    const getWaveOffset = (u: number, v: number, waterDepth: number) => {
      if (!physicsEnabled || waterDepth < 0.04) return 0;
      const waveAmp = Math.min(0.22, waterDepth * 0.14);
      return (
        (Math.sin(wavePhase * 2.2 + u * 16.0 + v * 10.0) * 0.55 +
         Math.cos(wavePhase * 1.5 - u * 12.0 + v * 14.0) * 0.35 +
         Math.sin((u + v) * 25.0 + wavePhase * 3.0) * 0.1) * waveAmp
      );
    };

    // Seismic displacement calculation: traveling Rayleigh and P/S waves physically displacing the 3D ground mesh
    const getSeismicDisp = (u: number, v: number, hVal: number) => {
      if (hazardType !== 'earthquake' || !physicsEnabled || hVal <= 0.05) return 0;
      const norm = getNormHazard('earthquake', hVal, peakVal);
      const dist = Math.hypot(u - 0.5, v - 0.5);
      // Traveling radial seismic wave radiating from epicentral center
      const wave = Math.sin(wavePhase * 4.2 - dist * 22.0) * 0.65 +
                   Math.cos(wavePhase * 2.6 + (u + v) * 12.0) * 0.35;
      // Vertical ground displacement in meters
      return wave * norm * 3.5;
    };

    // ─── Render 3D Quads (Back-to-Front) ───
    quads.forEach(({ r, c }) => {
      const u0 = c / (cols - 1);
      const u1 = (c + 1) / (cols - 1);
      const v0 = r / (rows - 1);
      const v1 = (r + 1) / (rows - 1);
      const uMid = (u0 + u1) / 2;
      const vMid = (v0 + v1) / 2;

      const e00 = elevGrid[r]?.[c] ?? minElev;
      const e10 = elevGrid[r]?.[c + 1] ?? minElev;
      const e11 = elevGrid[r + 1]?.[c + 1] ?? minElev;
      const e01 = elevGrid[r + 1]?.[c] ?? minElev;

      // Real-time sub-frame hazard values for each vertex
      const w00A = currentHazardGrid[r]?.[c] ?? 0;
      const w00B = nextHazardGrid[r]?.[c] ?? w00A;
      const w00 = w00A + (w00B - w00A) * subFraction;

      const w10A = currentHazardGrid[r]?.[c + 1] ?? 0;
      const w10B = nextHazardGrid[r]?.[c + 1] ?? w10A;
      const w10 = w10A + (w10B - w10A) * subFraction;

      const w11A = currentHazardGrid[r + 1]?.[c + 1] ?? 0;
      const w11B = nextHazardGrid[r + 1]?.[c + 1] ?? w11A;
      const w11 = w11A + (w11B - w11A) * subFraction;

      const w01A = currentHazardGrid[r + 1]?.[c] ?? 0;
      const w01B = nextHazardGrid[r + 1]?.[c] ?? w01A;
      const w01 = w01A + (w01B - w01A) * subFraction;

      const avgHazard = (w00 + w10 + w11 + w01) / 4;
      const normH = getNormHazard(hazardType, avgHazard, peakVal);
      const isHazardActive = isCellHazardActive(hazardType, avgHazard, peakVal);

      // In an earthquake, vertices physically shake with seismic wave propagation!
      const se00 = getSeismicDisp(u0, v0, w00);
      const se10 = getSeismicDisp(u1, v0, w10);
      const se11 = getSeismicDisp(u1, v1, w11);
      const se01 = getSeismicDisp(u0, v1, w01);

      const p00 = project(u0, v0, e00 + se00);
      const p10 = project(u1, v0, e10 + se10);
      const p11 = project(u1, v1, e11 + se11);
      const p01 = project(u0, v1, e01 + se01);

      // Directional shading based on local slope
      const dzX = (e10 - e00 + (e11 - e01)) * 0.5;
      const dzY = (e01 - e00 + (e11 - e10)) * 0.5;
      const slopeShade = Math.max(0.65, Math.min(1.35, 1.0 + (dzX * 0.04 - dzY * 0.03)));

      const avgElev = (e00 + e10 + e11 + e01) / 4;

      // ─── Ground Face Color tailored to the active hazard ───
      let faceColor = getTerrainColor(avgElev, slopeShade);

      if (isHazardActive) {
        if (hazardType === 'wildfire') {
          // Charred ground scar: blend towards dark ash / carbon black (#18181b to #27272a)
          const ashFactor = Math.min(1.0, normH * 1.3);
          const rBase = 24, gBase = 24, bBase = 27;
          faceColor = `rgb(${Math.round(rBase * ashFactor + (1 - ashFactor) * 50)}, ${Math.round(gBase * ashFactor + (1 - ashFactor) * 110)}, ${Math.round(bBase * ashFactor + (1 - ashFactor) * 70)})`;
        } else if (hazardType === 'earthquake') {
          // Seismic intensity tinting: golden amber to seismic red
          const rS = Math.round(245 * normH + (1 - normH) * 50);
          const gS = Math.round(158 * (1 - normH * 0.7) * normH + (1 - normH) * 110);
          const bS = Math.round(11 * normH + (1 - normH) * 70);
          faceColor = `rgb(${Math.min(255, rS)}, ${Math.min(255, gS)}, ${Math.min(255, bS)})`;
        } else if (hazardType === 'landslide') {
          // Earthy ochre / soil failure discoloration
          const rL = Math.round(180 * normH + (1 - normH) * 50);
          const gL = Math.round(83 * normH + (1 - normH) * 110);
          const bL = Math.round(9 * normH + (1 - normH) * 70);
          faceColor = `rgb(${rL}, ${gL}, ${bL})`;
        } else if (hazardType === 'cyclone') {
          // High wind shear turbulence shading (only above cyclonic gale threshold >= 62 km/h)
          if (avgHazard >= 62.0) {
            const rC = Math.round(14 * normH + (1 - normH) * 50);
            const gC = Math.round(165 * normH + (1 - normH) * 110);
            const bC = Math.round(233 * normH + (1 - normH) * 70);
            faceColor = `rgb(${rC}, ${gC}, ${bC})`;
          }
        }
      }

      // Draw Terrain Face
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fillStyle = faceColor;
      ctx.fill();

      ctx.strokeStyle = isHazardActive && hazardType === 'wildfire' ? 'rgba(234, 88, 12, 0.35)' : 'rgba(15, 23, 42, 0.4)';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // ─── UNIQUE 3D HAZARD PHENOMENON IMPLEMENTATION ───

      // 1. WILDFIRE: Volumetric 3D Flame Spires, Charred Ash & Drifting Embers
      if (hazardType === 'wildfire' && isHazardActive) {
        // Glowing ember veins inside charred scar
        if (physicsEnabled) {
          const emberPulse = (Math.sin(wavePhase * 4.0 + uMid * 24.0 + vMid * 18.0) + 1) * 0.5;
          if (emberPulse > 0.4) {
            ctx.strokeStyle = `rgba(234, 88, 12, ${(emberPulse * 0.7 * normH).toFixed(2)})`;
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.moveTo((p00.x + p10.x) / 2, (p00.y + p10.y) / 2);
            ctx.lineTo((p11.x + p01.x) / 2, (p11.y + p01.y) / 2);
            ctx.stroke();
          }
        }

        // 3D Volumetric Flame Tongues & Spikes rising into the air
        if (normH > 0.08) {
          const flameH = 1.5 + normH * 5.2;
          const flicker = physicsEnabled
            ? Math.sin(wavePhase * 6.5 + uMid * 30.0) * 0.35 + Math.cos(wavePhase * 4.8 + vMid * 25.0) * 0.25
            : 0;
          const swayNoise = physicsEnabled
            ? Math.sin(wavePhase * 4.5 + uMid * 20.0) * 0.005
            : 0;
          const windSwayX = wfDownwindU * wfLeanMagnitude + swayNoise;
          const windSwayY = wfDownwindV * wfLeanMagnitude + swayNoise;

          const groundMidE = avgElev;
          const apex = project(uMid + windSwayX, vMid + windSwayY, groundMidE + flameH * (1.0 + flicker));
          const baseA = project(u0 * 0.7 + u1 * 0.3, v0 * 0.7 + v1 * 0.3, groundMidE + 0.1);
          const baseB = project(u1 * 0.7 + u0 * 0.3, v1 * 0.7 + v0 * 0.3, groundMidE + 0.1);
          const midTongue = project(uMid + windSwayX * 0.5, vMid + windSwayY * 0.5, groundMidE + flameH * 0.55);

          // Draw 3D Flame Tongue with fiery vertical gradient
          const flameGrad = ctx.createLinearGradient(baseA.x, baseA.y, apex.x, apex.y);
          flameGrad.addColorStop(0, 'rgba(254, 240, 138, 0.95)'); // Incandescent core yellow
          flameGrad.addColorStop(0.45, 'rgba(249, 115, 22, 0.88)'); // Blazing orange body
          flameGrad.addColorStop(1, 'rgba(220, 38, 38, 0.75)'); // Smoky crimson tip

          ctx.beginPath();
          ctx.moveTo(baseA.x, baseA.y);
          ctx.quadraticCurveTo(midTongue.x - 3, midTongue.y, apex.x, apex.y);
          ctx.quadraticCurveTo(midTongue.x + 3, midTongue.y, baseB.x, baseB.y);
          ctx.closePath();
          ctx.fillStyle = flameGrad;
          ctx.fill();

          // Drifting Ember Sparks floating into 3D sky above the fire front
          if (physicsEnabled && normH > 0.35) {
            const sparkPhase = (wavePhase * 3.5 + uMid * 50.0) % (Math.PI * 2);
            const sparkYOffset = (sparkPhase / (Math.PI * 2)) * 4.0;
            const sparkPt = project(uMid + windSwayX * 1.5, vMid + windSwayY * 1.5, groundMidE + flameH + sparkYOffset);
            ctx.fillStyle = `rgba(251, 191, 36, ${(1.0 - sparkPhase / (Math.PI * 2)).toFixed(2)})`;
            ctx.fillRect(sparkPt.x - 1.5, sparkPt.y - 1.5, 3, 3);
          }
        }
      }

      // 2. EARTHQUAKE: Surface Fault Fissures and Shockwave Contours
      else if (hazardType === 'earthquake' && isHazardActive) {
        if (normH > 0.45) {
          ctx.beginPath();
          const jx = (Math.sin(uMid * 40.0 + vMid * 30.0) - 0.5) * 4;
          const jy = (Math.cos(uMid * 35.0 + vMid * 45.0) - 0.5) * 4;
          ctx.moveTo(p00.x, p00.y);
          ctx.lineTo((p10.x + p01.x) / 2 + jx, (p10.y + p01.y) / 2 + jy);
          ctx.lineTo(p11.x, p11.y);
          ctx.strokeStyle = normH > 0.75 ? '#dc2626' : '#ea580c';
          ctx.lineWidth = normH > 0.75 ? 2.2 : 1.4;
          ctx.stroke();
        }

        // Seismic shockwave pulse contour
        if (physicsEnabled) {
          const pulse = (Math.sin(wavePhase * 4.0 - Math.hypot(uMid - 0.5, vMid - 0.5) * 20.0) + 1) * 0.5;
          if (pulse > 0.75) {
            ctx.strokeStyle = `rgba(239, 68, 68, ${((pulse - 0.75) * 3.0 * normH).toFixed(2)})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(p00.x, p00.y);
            ctx.lineTo(p10.x, p10.y);
            ctx.lineTo(p11.x, p11.y);
            ctx.lineTo(p01.x, p01.y);
            ctx.closePath();
            ctx.stroke();
          }
        }
      }

      // 3. LANDSLIDE: Viscous Chocolate/Terracotta Mudflow Layer & Boulders
      else if (hazardType === 'landslide' && isHazardActive) {
        const mudDepth = 0.25 + normH * 1.8;
        const mp00 = project(u0, v0, e00 + mudDepth);
        const mp10 = project(u1, v0, e10 + mudDepth);
        const mp11 = project(u1, v1, e11 + mudDepth);
        const mp01 = project(u0, v1, e01 + mudDepth);

        ctx.beginPath();
        ctx.moveTo(mp00.x, mp00.y);
        ctx.lineTo(mp10.x, mp10.y);
        ctx.lineTo(mp11.x, mp11.y);
        ctx.lineTo(mp01.x, mp01.y);
        ctx.closePath();

        const mudAlpha = Math.min(0.94, 0.65 + normH * 0.28);
        const rMud = Math.round(120 - normH * 40);
        const gMud = Math.round(53 - normH * 25);
        const bMud = Math.round(15 + normH * 10);
        ctx.fillStyle = `rgba(${rMud}, ${gMud}, ${bMud}, ${mudAlpha})`;
        ctx.fill();

        ctx.strokeStyle = 'rgba(69, 26, 3, 0.6)';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // Viscous creeping ridges along slope descent
        if (physicsEnabled && normH > 0.3) {
          const flowShift = Math.sin(wavePhase * 2.0 + vMid * 16.0) * 2.0;
          ctx.strokeStyle = 'rgba(180, 83, 9, 0.55)';
          ctx.lineWidth = 1.0;
          ctx.beginPath();
          ctx.moveTo(mp00.x + flowShift, mp00.y);
          ctx.lineTo(mp11.x + flowShift, mp11.y);
          ctx.stroke();
        }

        // Scattered rocky debris boulders on the mudflow
        if (normH > 0.45 && (r + c) % 2 === 0) {
          const boulderPt = project(uMid, vMid, avgElev + mudDepth + 0.4);
          ctx.fillStyle = '#292524'; // dark granite stone
          ctx.fillRect(boulderPt.x - 2, boulderPt.y - 2, 4, 3);
          ctx.strokeStyle = '#78716c';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(boulderPt.x - 2, boulderPt.y - 2, 4, 3);
        }
      }

      // 4. CYCLONE: Coastal Storm Surge Hydrodynamic Inundation
      else if (hazardType === 'cyclone') {
        const meta = (result.simulation as any)?.metadata || {};
        const surgeGrid: number[][] | undefined = meta.surge_grid;
        const cellSurge = surgeGrid?.[r]?.[c] ?? 0;
        const isLowElevation = avgElev <= minElev + elevSpan * 0.25;

        // Dynamic time-dependent storm surge factor from simulation timeline
        const surgeTimeFactors: number[] | undefined = meta.surge_time_factors;
        let timeSurgeFactor = 0;
        if (surgeTimeFactors && surgeTimeFactors.length > 0) {
          const curF = Math.min(surgeTimeFactors.length - 1, Math.max(0, Math.floor(animFrame)));
          const nxtF = Math.min(surgeTimeFactors.length - 1, curF + 1);
          const fA = surgeTimeFactors[curF] ?? 0;
          const fB = surgeTimeFactors[nxtF] ?? fA;
          timeSurgeFactor = fA + (fB - fA) * subFraction;
        } else {
          // Fallback based on local wind intensity exceeding tropical gale threshold (62 km/h)
          timeSurgeFactor = Math.min(1.0, Math.max(0, (avgHazard - 35) / Math.max(30, peakVal - 35)));
        }

        const effectiveSurge = cellSurge * Math.pow(timeSurgeFactor, 1.25);
        const hasSurge = isLowElevation && effectiveSurge > 0.05;

        if (hasSurge) {
          const surgeWaterElev = Math.max(avgElev + 0.12, minElev + effectiveSurge);
          const wOff00 = physicsEnabled ? Math.sin(u0 * 20 + wavePhase * 3.2) * 0.08 : 0;
          const wOff10 = physicsEnabled ? Math.sin(u1 * 20 + wavePhase * 3.2) * 0.08 : 0;
          const wOff11 = physicsEnabled ? Math.sin(u1 * 20 + wavePhase * 3.2) * 0.08 : 0;
          const wOff01 = physicsEnabled ? Math.sin(u0 * 20 + wavePhase * 3.2) * 0.08 : 0;

          const sp00 = project(u0, v0, Math.max(e00, surgeWaterElev) + wOff00);
          const sp10 = project(u1, v0, Math.max(e10, surgeWaterElev) + wOff10);
          const sp11 = project(u1, v1, Math.max(e11, surgeWaterElev) + wOff11);
          const sp01 = project(u0, v1, Math.max(e01, surgeWaterElev) + wOff01);

          ctx.beginPath();
          ctx.moveTo(sp00.x, sp00.y);
          ctx.lineTo(sp10.x, sp10.y);
          ctx.lineTo(sp11.x, sp11.y);
          ctx.lineTo(sp01.x, sp01.y);
          ctx.closePath();

          // Coastal storm surge water color: deep sea cyan with translucent specular foam
          ctx.fillStyle = 'rgba(6, 182, 212, 0.78)';
          ctx.fill();

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.0;
          ctx.stroke();
        }
      }

      // 5. FLOOD: Hydrodynamic Fluid Water Mesh with Specular Sunlight Waves & Foam
      else if (hazardType === 'flood' && isHazardActive && avgHazard > 0.03) {
        const wave00 = getWaveOffset(u0, v0, w00);
        const wave10 = getWaveOffset(u1, v0, w10);
        const wave11 = getWaveOffset(u1, v1, w11);
        const wave01 = getWaveOffset(u0, v1, w01);

        const wp00 = project(u0, v0, e00 + Math.max(0.01, w00 + wave00));
        const wp10 = project(u1, v0, e10 + Math.max(0.01, w10 + wave10));
        const wp11 = project(u1, v1, e11 + Math.max(0.01, w11 + wave11));
        const wp01 = project(u0, v1, e01 + Math.max(0.01, w01 + wave01));

        ctx.beginPath();
        ctx.moveTo(wp00.x, wp00.y);
        ctx.lineTo(wp10.x, wp10.y);
        ctx.lineTo(wp11.x, wp11.y);
        ctx.lineTo(wp01.x, wp01.y);
        ctx.closePath();

        // Real-time wave sunlight specular reflection
        const waveSlopeX = Math.cos(wavePhase * 2.2 + u0 * 16.0);
        const waveSlopeY = Math.sin(wavePhase * 1.5 + v0 * 14.0);
        const lightReflect = Math.max(0, 0.6 + waveSlopeX * 0.25 - waveSlopeY * 0.25);
        const specular = physicsEnabled ? Math.pow(lightReflect, 5) * 0.35 : 0;

        // Depth-dependent color: shallow crystal turquoise to deep indigo cobalt
        const depthFactor = Math.min(1.0, avgHazard / 2.8);
        const rCol = Math.round(18 + (1 - depthFactor) * 20 + specular * 210);
        const gCol = Math.round(110 + (1 - depthFactor) * 75 + specular * 210);
        const bCol = Math.round(215 + depthFactor * 35 + specular * 255);
        const alphaCol = Math.min(0.92, 0.48 + depthFactor * 0.4);

        ctx.fillStyle = `rgba(${Math.min(255, rCol)}, ${Math.min(255, gCol)}, ${Math.min(255, bCol)}, ${alphaCol})`;
        ctx.fill();

        // Shoreline foam highlight where water meets land
        if (avgHazard < 0.22) {
          ctx.strokeStyle = `rgba(224, 242, 254, ${(0.65 * (1 - avgHazard / 0.22)).toFixed(2)})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(147, 197, 253, 0.35)';
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }

      // ─── Tactical 3D Tile Micro-Number (Top Corner of Each Tile) ───
      if (tileNumberMode !== 'off') {
        let label = '';
        if (tileNumberMode === 'id') {
          label = `${r * (cols - 1) + c + 1}`;
        } else if (tileNumberMode === 'elev') {
          label = `${Math.round(avgElev)}m`;
        } else if (tileNumberMode === 'hazard') {
          if (isHazardActive) {
            if (hazardType === 'flood') label = `${avgHazard.toFixed(1)}m`;
            else if (hazardType === 'earthquake') label = `${avgHazard.toFixed(1)}`;
            else if (hazardType === 'cyclone') label = `${Math.round(avgHazard)}k`;
            else if (hazardType === 'wildfire') label = `${Math.round(normH * 100)}%`;
            else if (hazardType === 'landslide') label = `${normH.toFixed(2)}`;
          } else {
            label = '0';
          }
        }

        if (label) {
          const cornerU = u0 + (u1 - u0) * 0.12;
          const cornerV = v0 + (v1 - v0) * 0.12;
          const cornerZ =
            e00 +
            (hazardType === 'earthquake' ? se00 : 0) +
            (hazardType === 'flood' && isHazardActive && avgHazard > 0.03 ? avgHazard + 0.15 : 0.3);
          const cornerPt = project(cornerU, cornerV, cornerZ);

          ctx.save();
          ctx.font = '600 8.5px "JetBrains Mono", "SF Mono", monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';

          const textW = ctx.measureText(label).width;
          // Tactical translucent dark pill backing
          ctx.fillStyle = isHazardActive ? 'rgba(15, 23, 42, 0.85)' : 'rgba(10, 15, 29, 0.72)';
          ctx.fillRect(cornerPt.x - 2, cornerPt.y - 1, textW + 4, 11);

          // Subtle outline border
          ctx.strokeStyle = isHazardActive
            ? (hazardType === 'wildfire' ? 'rgba(249, 115, 22, 0.7)' : 'rgba(239, 68, 68, 0.65)')
            : 'rgba(56, 189, 248, 0.35)';
          ctx.lineWidth = 0.6;
          ctx.strokeRect(cornerPt.x - 2, cornerPt.y - 1, textW + 4, 11);

          // Text color
          ctx.fillStyle = isHazardActive
            ? (hazardType === 'wildfire' ? '#fef08a' : '#f87171')
            : 'rgba(224, 242, 254, 0.9)';
          ctx.fillText(label, cornerPt.x, cornerPt.y);
          ctx.restore();
        }
      }
    });

    // ─── CYCLONE: Dynamic Moving 3D Atmospheric Vortex, Eyewall & Ground Track ───
    if (hazardType === 'cyclone' && peakVal > 15) {
      const meta = (result.simulation as any)?.metadata || {};
      const trackPoints: Array<{ time_h: number; lat: number; lon: number; eye_u: number; eye_v: number; wind_kmh: number }> =
        meta.track_points || [];
      const dirDeg = Number(meta.cyclone_direction_deg ?? 315);
      const rMaxKm = Number(meta.cyclone_radius_km ?? 35);
      const stormRadiusKm = Number(meta.storm_radius_km ?? 180);
      const category = String(meta.saffir_simpson_category || 'Tropical Storm');

      // Continuous dynamic eye interpolation along the calculated simulation track
      const tFrac = Math.max(0, Math.min(1, animFrame / Math.max(totalFrames - 1, 1)));
      let eyeU = 0.5;
      let eyeV = 0.5;
      let curWindKmh = peakVal;

      if (trackPoints.length >= 2) {
        const trackPos = tFrac * (trackPoints.length - 1);
        const idxA = Math.floor(trackPos);
        const idxB = Math.min(trackPoints.length - 1, idxA + 1);
        const subT = trackPos - idxA;
        const ptA = trackPoints[idxA];
        const ptB = trackPoints[idxB];
        eyeU = ptA.eye_u + subT * (ptB.eye_u - ptA.eye_u);
        eyeV = ptA.eye_v + subT * (ptB.eye_v - ptA.eye_v);
        curWindKmh = ptA.wind_kmh + subT * (ptB.wind_kmh - ptA.wind_kmh);
      } else {
        // Fallback directional movement along dirDeg
        const dirRad = ((dirDeg - 90) * Math.PI) / 180;
        const spanDist = 0.9;
        eyeU = 0.5 + (tFrac - 0.5) * Math.cos(dirRad) * spanDist;
        eyeV = 0.5 + (tFrac - 0.5) * Math.sin(dirRad) * spanDist;
      }

      const clampEyeR = Math.min(rows - 1, Math.max(0, Math.floor(eyeV * rows)));
      const clampEyeC = Math.min(cols - 1, Math.max(0, Math.floor(eyeU * cols)));
      const eyeGroundElev = elevGrid[clampEyeR]?.[clampEyeC] ?? minElev;
      const vortexAltitude = Math.max(maxElev + 10.0, eyeGroundElev + 14.0);

      ctx.save();

      // 1. Projected 3D Ground Trajectory Track across the terrain
      if (trackPoints.length >= 2) {
        ctx.beginPath();
        let trackStarted = false;
        trackPoints.forEach((pt) => {
          if (pt.eye_u < -0.15 || pt.eye_u > 1.15 || pt.eye_v < -0.15 || pt.eye_v > 1.15) return;
          const pr = Math.min(rows - 1, Math.max(0, Math.floor(pt.eye_v * rows)));
          const pc = Math.min(cols - 1, Math.max(0, Math.floor(pt.eye_u * cols)));
          const gE = (elevGrid[pr]?.[pc] ?? minElev) + 2.0;
          const pScreen = project(pt.eye_u, pt.eye_v, gE);
          if (!trackStarted) {
            ctx.moveTo(pScreen.x, pScreen.y);
            trackStarted = true;
          } else {
            ctx.lineTo(pScreen.x, pScreen.y);
          }
        });
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = 2.4;
        ctx.setLineDash([8, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Waypoint markers along track
        trackPoints.forEach((pt, i) => {
          if (pt.eye_u < 0 || pt.eye_u > 1 || pt.eye_v < 0 || pt.eye_v > 1) return;
          const pr = Math.min(rows - 1, Math.max(0, Math.floor(pt.eye_v * rows)));
          const pc = Math.min(cols - 1, Math.max(0, Math.floor(pt.eye_u * cols)));
          const gE = (elevGrid[pr]?.[pc] ?? minElev) + 2.0;
          const ptScreen = project(pt.eye_u, pt.eye_v, gE);
          ctx.beginPath();
          ctx.arc(ptScreen.x, ptScreen.y, i === 0 || i === trackPoints.length - 1 ? 4.5 : 3.0, 0, Math.PI * 2);
          ctx.fillStyle = '#facc15';
          ctx.fill();
        });
      }

      // 2. Parabolic Upper Atmospheric Cloud Canopy & Eyewall Stadium Funnel
      const canopyRadiusNorm = Math.max(0.42, Math.min(0.85, (stormRadiusKm / 180) * 0.58));
      const eyeRadiusNorm = Math.max(0.035, Math.min(0.12, (rMaxKm / 45) * 0.065));
      const canopyTopAlt = vortexAltitude + 16.0;

      // Draw multi-tier rotating translucent cloud canopy discs
      const numTiers = 4;
      for (let tier = 0; tier < numTiers; tier++) {
        const tierFrac = (tier + 1) / numTiers;
        const tierRadius = eyeRadiusNorm + tierFrac * (canopyRadiusNorm - eyeRadiusNorm);
        const tierAlt = vortexAltitude + tierFrac * 12.0;
        ctx.beginPath();
        let ringStarted = false;
        const numRingSteps = 32;
        for (let s = 0; s <= numRingSteps; s++) {
          const ringAngle = (s / numRingSteps) * Math.PI * 2 + (physicsEnabled ? wavePhase * (1.2 - tierFrac * 0.6) : 0);
          const ru = eyeU + Math.cos(ringAngle) * tierRadius;
          const rv = eyeV + Math.sin(ringAngle) * tierRadius;
          const rpt = project(ru, rv, tierAlt + Math.sin(s * 0.6 + wavePhase * 2) * 1.5);
          if (!ringStarted) {
            ctx.moveTo(rpt.x, rpt.y);
            ringStarted = true;
          } else {
            ctx.lineTo(rpt.x, rpt.y);
          }
        }
        ctx.strokeStyle = `rgba(240, 249, 255, ${0.18 - tier * 0.03})`;
        ctx.lineWidth = 2.5 + tier * 1.5;
        ctx.stroke();
      }

      // 3. Eyewall Stadium Effect: Vertical sloping stadium ribs connecting ground to cloud ceiling
      const numStadiumRibs = 16;
      for (let sr = 0; sr < numStadiumRibs; sr++) {
        const ribAngle = (sr / numStadiumRibs) * Math.PI * 2 + (physicsEnabled ? wavePhase * 2.8 : 0);
        const groundU = eyeU + Math.cos(ribAngle) * eyeRadiusNorm;
        const groundV = eyeV + Math.sin(ribAngle) * eyeRadiusNorm;
        const canopyU = eyeU + Math.cos(ribAngle) * (eyeRadiusNorm * 1.6);
        const canopyV = eyeV + Math.sin(ribAngle) * (eyeRadiusNorm * 1.6);

        const rRow = Math.min(rows - 1, Math.max(0, Math.floor(groundV * rows)));
        const rCol = Math.min(cols - 1, Math.max(0, Math.floor(groundU * cols)));
        const groundE = (elevGrid[rRow]?.[rCol] ?? minElev) + 1.0;

        const pGround = project(groundU, groundV, groundE);
        const pCanopy = project(canopyU, canopyV, canopyTopAlt);

        ctx.beginPath();
        ctx.moveTo(pGround.x, pGround.y);
        ctx.lineTo(pCanopy.x, pCanopy.y);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 4. Rotating Logarithmic Spiral Rainbands with Convective Cloud Puffs
      const numArms = 8;
      const bLog = 0.22;
      for (let a = 0; a < numArms; a++) {
        const baseAngle = (a / numArms) * Math.PI * 2;
        const currentRot = baseAngle + (physicsEnabled ? wavePhase * 2.8 : 0);

        ctx.beginPath();
        let started = false;
        for (let step = 0; step < 28; step++) {
          const t = step / 28;
          const rad = eyeRadiusNorm * Math.exp(bLog * t * Math.PI * 2.4);
          if (rad > canopyRadiusNorm) break;
          const angle = currentRot + t * Math.PI * 2.2;
          const su = eyeU + Math.cos(angle) * rad;
          const sv = eyeV + Math.sin(angle) * rad;
          if (su < -0.15 || su > 1.15 || sv < -0.15 || sv > 1.15) continue;
          const sAlt = vortexAltitude + Math.sin(t * Math.PI) * 5.0 + Math.cos(step * 0.4 + wavePhase) * 1.2;
          const spt = project(su, sv, sAlt);
          if (!started) {
            ctx.moveTo(spt.x, spt.y);
            started = true;
          } else {
            ctx.lineTo(spt.x, spt.y);
          }

          // Convective cloud puff along outer spiral arms
          if (step % 7 === 0 && step > 7) {
            ctx.arc(spt.x, spt.y, 4.0 + (step / 28) * 6.0, 0, Math.PI * 2);
          }
        }
        ctx.strokeStyle = a % 2 === 0 ? 'rgba(56, 189, 248, 0.85)' : 'rgba(192, 132, 252, 0.75)';
        ctx.lineWidth = a % 2 === 0 ? 2.4 : 1.8;
        ctx.setLineDash([10, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 5. Cyclone Eye Wall (Glowing Concentric Rings & Calm Eye)
      const eyePt = project(eyeU, eyeV, vortexAltitude + 3);
      const eyeScreenRadius = Math.max(12, Math.min(32, (rMaxKm / 35) * 18));

      // Outer eyewall neon halo
      ctx.beginPath();
      ctx.arc(eyePt.x, eyePt.y, eyeScreenRadius * 1.15, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
      ctx.lineWidth = 6.0;
      ctx.stroke();

      // Outer violent eyewall
      ctx.beginPath();
      ctx.arc(eyePt.x, eyePt.y, eyeScreenRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.95)';
      ctx.lineWidth = 2.8;
      ctx.stroke();

      // Inner calm eye ring
      ctx.beginPath();
      ctx.arc(eyePt.x, eyePt.y, Math.max(5, eyeScreenRadius * 0.45), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 2.0;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
      ctx.fill();
      ctx.stroke();

      // 6. Floating 3D Tactical Cyclone Tracker HUD Badge
      const hudPt = project(eyeU, eyeV, vortexAltitude + 8);
      const catShort = category.includes('Category') ? category.split(' ')[0] + ' ' + category.split(' ')[1] : category;
      const pcVal = meta.central_pressure_hpa ? Math.round(meta.central_pressure_hpa) : 945;
      const surgeVal = meta.estimated_coastal_surge_m ? Number(meta.estimated_coastal_surge_m).toFixed(1) : '2.5';
      const line1 = `🌀 ${catShort} • ${Math.round(curWindKmh)} km/h • ${pcVal} hPa`;
      const line2 = `Rmax ${Math.round(rMaxKm)}km • Heading ${Math.round(dirDeg)}° • Surge +${surgeVal}m`;

      ctx.font = '700 11px "JetBrains Mono", monospace';
      const w1 = ctx.measureText(line1).width;
      ctx.font = '500 9.5px "JetBrains Mono", monospace';
      const w2 = ctx.measureText(line2).width;
      const maxW = Math.max(w1, w2);

      const padX = 10;
      const boxW = maxW + padX * 2;
      const boxH = 34;
      const boxX = hudPt.x - boxW / 2;
      const boxY = hudPt.y - boxH - 8;

      ctx.fillStyle = 'rgba(11, 19, 32, 0.94)';
      ctx.strokeStyle = curWindKmh >= 209 ? '#f43f5e' : curWindKmh >= 154 ? '#fb923c' : '#38bdf8';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      // Line 1: Category & Wind
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.fillStyle = curWindKmh >= 209 ? '#f43f5e' : curWindKmh >= 154 ? '#fb923c' : '#38bdf8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(line1, hudPt.x, boxY + 4);

      // Line 2: Details
      ctx.font = '500 9.5px "JetBrains Mono", monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(line2, hudPt.x, boxY + 18);

      ctx.restore();
    }

    // ─── WILDFIRE: Dynamic 3D Ignition Beacon, Downwind Smoke Plumes & Wind Vector HUD ───
    if (hazardType === 'wildfire') {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      const ignLat = Number(wfSimMeta.ignition_lat ?? (b.north + b.south) / 2);
      const ignLon = Number(wfSimMeta.ignition_lon ?? (b.east + b.west) / 2);
      const initRadiusM = Number(wfSimMeta.initial_fire_radius_m ?? 10);
      const fuelTypeStr = String(wfSimMeta.fuel_type || 'grass').toUpperCase();
      const fireDanger = String(wfSimMeta.fire_danger_rating || 'HIGH');

      const ignU = (ignLon - b.west) / lonSpan;
      const ignV = (b.north - ignLat) / latSpan;

      const clampIgnR = Math.min(rows - 1, Math.max(0, Math.floor(ignV * rows)));
      const clampIgnC = Math.min(cols - 1, Math.max(0, Math.floor(ignU * cols)));
      const ignGroundE = elevGrid[clampIgnR]?.[clampIgnC] ?? minElev;

      ctx.save();

      // 1. 3D Pulsating Ignition Source Beacon at (ignU, ignV)
      if (ignU >= -0.1 && ignU <= 1.1 && ignV >= -0.1 && ignV <= 1.1) {
        // Base concentric footprint rings on ground
        const numRings = 3;
        for (let ring = 0; ring < numRings; ring++) {
          const ringRad = 0.015 + ring * 0.012 + (physicsEnabled ? Math.sin(wavePhase * 3.0 + ring) * 0.004 : 0);
          ctx.beginPath();
          for (let step = 0; step <= 24; step++) {
            const a = (step / 24) * Math.PI * 2;
            const ru = ignU + Math.cos(a) * ringRad;
            const rv = ignV + Math.sin(a) * ringRad;
            const rpt = project(ru, rv, ignGroundE + 0.3);
            if (step === 0) ctx.moveTo(rpt.x, rpt.y);
            else ctx.lineTo(rpt.x, rpt.y);
          }
          ctx.closePath();
          ctx.strokeStyle = ring === 0 ? 'rgba(254, 240, 138, 0.9)' : 'rgba(249, 115, 22, 0.6)';
          ctx.lineWidth = ring === 0 ? 2.0 : 1.2;
          ctx.stroke();
        }

        // Vertical Laser Beacon Spire shooting into the sky
        const beaconTopH = ignGroundE + 24.0;
        const pBase = project(ignU, ignV, ignGroundE + 0.2);
        const pTop = project(ignU, ignV, beaconTopH);

        const beaconGrad = ctx.createLinearGradient(pBase.x, pBase.y, pTop.x, pTop.y);
        beaconGrad.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
        beaconGrad.addColorStop(0.3, 'rgba(249, 115, 22, 0.7)');
        beaconGrad.addColorStop(1, 'rgba(220, 38, 38, 0.1)');

        ctx.strokeStyle = beaconGrad;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(pBase.x, pBase.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.stroke();

        // Pulsing Beacon Orb atop the beam
        const orbRadius = 5.0 + (physicsEnabled ? Math.sin(wavePhase * 5.0) * 1.5 : 0);
        ctx.beginPath();
        ctx.arc(pTop.x, pTop.y, orbRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#fef08a';
        ctx.fill();

        // Tactical 3D HUD Tag for Ignition Origin
        const hudX = pTop.x;
        const hudY = pTop.y - 14;
        const ignLabel = `📍 IGNITION SOURCE: ${ignLat.toFixed(3)}°N, ${ignLon.toFixed(3)}°E (R=${initRadiusM}m)`;
        ctx.font = '700 9.5px "JetBrains Mono", monospace';
        const ignTextW = ctx.measureText(ignLabel).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(hudX - ignTextW / 2 - 6, hudY - 9, ignTextW + 12, 18);
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 1.0;
        ctx.strokeRect(hudX - ignTextW / 2 - 6, hudY - 9, ignTextW + 12, 18);
        ctx.fillStyle = '#fef08a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ignLabel, hudX, hudY);
      }

      // 2. Volumetric Downwind Smoke Plumes billowing from active fire
      if (physicsEnabled) {
        const activeFireCells: Array<{ u: number; v: number; e: number; norm: number }> = [];
        for (let r = 0; r < rows; r += 2) {
          for (let c = 0; c < cols; c += 2) {
            const vVal = currentHazardGrid[r]?.[c] ?? 0;
            if (vVal > 0.25) {
              const uC = (c + 0.5) / cols;
              const vC = (r + 0.5) / rows;
              const gE = elevGrid[r]?.[c] ?? minElev;
              activeFireCells.push({ u: uC, v: vC, e: gE, norm: Math.min(1.0, vVal) });
            }
          }
        }

        // Limit to 18 plumes for buttery 60fps performance
        const sampledCells = activeFireCells.slice(0, 18);
        sampledCells.forEach((cell, idx) => {
          const numParticles = 4;
          for (let p = 1; p <= numParticles; p++) {
            const driftDist = (p * 0.032) * (wfWindSpeed / 30);
            const liftDist = p * 2.8;
            const puffU = cell.u + wfDownwindU * driftDist + Math.sin(wavePhase * 2.0 + idx + p) * 0.008;
            const puffV = cell.v + wfDownwindV * driftDist + Math.cos(wavePhase * 2.0 + idx + p) * 0.008;
            const puffPt = project(puffU, puffV, cell.e + liftDist);

            const puffRadius = Math.max(3, 4 + p * 3.5);
            const puffAlpha = Math.max(0.04, (1.0 - p / (numParticles + 1)) * 0.35 * cell.norm);

            ctx.beginPath();
            ctx.arc(puffPt.x, puffPt.y, puffRadius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(51, 65, 85, ${puffAlpha.toFixed(2)})`;
            ctx.fill();
          }
        });
      }

      // 3. Floating 3D Wind Vector Compass & Fire Telemetry HUD
      {
        const hudAnchorU = 0.14;
        const hudAnchorV = 0.14;
        const hudAlt = maxElev + 8.0;
        const anchorPt = project(hudAnchorU, hudAnchorV, hudAlt);

        // Vector arrow end in downwind direction
        const arrowDist = 0.12 * Math.min(1.5, Math.max(0.6, wfWindSpeed / 25));
        const arrowTipU = hudAnchorU + wfDownwindU * arrowDist;
        const arrowTipV = hudAnchorV + wfDownwindV * arrowDist;
        const arrowTipPt = project(arrowTipU, arrowTipV, hudAlt);

        // Draw 3D Wind Vector Shaft
        ctx.beginPath();
        ctx.moveTo(anchorPt.x, anchorPt.y);
        ctx.lineTo(arrowTipPt.x, arrowTipPt.y);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.8;
        ctx.stroke();

        // Wind Arrowhead
        const arrAngle = Math.atan2(arrowTipPt.y - anchorPt.y, arrowTipPt.x - anchorPt.x);
        ctx.beginPath();
        ctx.moveTo(arrowTipPt.x, arrowTipPt.y);
        ctx.lineTo(arrowTipPt.x - Math.cos(arrAngle - 0.45) * 10, arrowTipPt.y - Math.sin(arrAngle - 0.45) * 10);
        ctx.lineTo(arrowTipPt.x - Math.cos(arrAngle + 0.45) * 10, arrowTipPt.y - Math.sin(arrAngle + 0.45) * 10);
        ctx.closePath();
        ctx.fillStyle = '#38bdf8';
        ctx.fill();

        // Telemetry HUD Card
        const windLabel = `🌬️ WIND: ${wfWindSpeed} km/h • ${wfWindDir}° [${fuelTypeStr} • ${fireDanger}]`;
        ctx.font = '700 9px "JetBrains Mono", monospace';
        const windTextW = ctx.measureText(windLabel).width;
        ctx.fillStyle = 'rgba(10, 15, 29, 0.88)';
        ctx.fillRect(anchorPt.x - 10, anchorPt.y - 18, windTextW + 16, 16);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(anchorPt.x - 10, anchorPt.y - 18, windTextW + 16, 16);
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(windLabel, anchorPt.x - 2, anchorPt.y - 10);
      }

      ctx.restore();
    }

    // ─── Render 3D Roads Network with Real-Time Hazard Tracking ───
    {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      (result.geodata?.roads || []).forEach((road: RoadFeature) => {
        if (road.coords.length < 2) return;
        ctx.beginPath();
        let maxRoadH = 0;

        road.coords.forEach((coord, i) => {
          const u = (coord[0] - b.west) / lonSpan;
          const v = (b.north - coord[1]) / latSpan;
          const r = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
          const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
          const groundE = elevGrid[r]?.[c] ?? minElev;

          const wA = currentHazardGrid[r]?.[c] ?? 0;
          const wB = nextHazardGrid[r]?.[c] ?? wA;
          const localH = wA + (wB - wA) * subFraction;
          if (localH > maxRoadH) maxRoadH = localH;

          // In earthquake, ground displacement shakes road coordinates
          const disp =
            hazardType === 'earthquake' && physicsEnabled && localH > 0.05
              ? Math.sin(wavePhase * 4.2 - Math.hypot(u - 0.5, v - 0.5) * 22.0) *
                getNormHazard('earthquake', localH, peakVal) *
                3.5
              : 0;

          const p = project(u, v, groundE + disp + 0.3);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });

        const isRoadImp = isCellHazardActive(hazardType, maxRoadH, peakVal);
        const normRoad = getNormHazard(hazardType, maxRoadH, peakVal);

        let col = 'rgba(52, 211, 153, 0.85)'; // Default green / open
        let lw = 1.5;

        if (isRoadImp) {
          if (hazardType === 'wildfire') {
            col = normRoad > 0.5 ? '#27272a' : '#ea580c'; // Charred or flame orange
            lw = normRoad > 0.5 ? 2.6 : 2.0;
          } else if (hazardType === 'earthquake') {
            col = normRoad > 0.5 ? '#ef4444' : '#f59e0b'; // Buckled red or amber
            lw = normRoad > 0.5 ? 2.5 : 1.9;
          } else if (hazardType === 'landslide') {
            col = normRoad > 0.4 ? '#78350f' : '#b45309'; // Mud buried chocolate
            lw = normRoad > 0.4 ? 2.8 : 2.0;
          } else if (hazardType === 'cyclone') {
            col = normRoad > 0.5 ? '#a855f7' : '#06b6d4'; // Gale purple or cyan
            lw = normRoad > 0.5 ? 2.4 : 1.8;
          } else {
            // flood
            col = normRoad > 0.45 ? '#ef4444' : '#f59e0b';
            lw = normRoad > 0.45 ? 2.4 : 2.0;
          }
        }

        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.stroke();
      });
    }

    // ─── Render 3D Buildings with Hazard-Specific Damage & Physics ───
    if (showBuildings) {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      const buildings = result.impact?.buildings || result.geodata?.buildings || [];

      buildings.forEach((bd: any) => {
        const cent = bd.centroid;
        if (!cent || typeof cent.lat !== 'number' || typeof cent.lon !== 'number') return;
        const u = (cent.lon - b.west) / lonSpan;
        const v = (b.north - cent.lat) / latSpan;
        if (u < 0 || u > 1 || v < 0 || v > 1) return;
        const r = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
        const groundE = elevGrid[r]?.[c] ?? minElev;
        let heightM = Math.max(1.5, bd.height_m || (bd.levels || 1) * 3.2);

        const wA = currentHazardGrid[r]?.[c] ?? 0;
        const wB = nextHazardGrid[r]?.[c] ?? wA;
        const cellH = wA + (wB - wA) * subFraction;

        const isImp = isCellHazardActive(hazardType, cellH, peakVal);
        const normH = getNormHazard(hazardType, cellH, peakVal);

        // Dynamic seismic sway or aerodynamic displacement
        let swayU = 0;
        let swayV = 0;
        let bldgDispZ = 0;

        if (hazardType === 'earthquake' && physicsEnabled && isImp) {
          bldgDispZ = Math.sin(wavePhase * 4.2 - Math.hypot(u - 0.5, v - 0.5) * 22.0) * normH * 3.5;
          swayU = Math.sin(wavePhase * 8.0 + u * 40.0) * 0.003 * normH;
          swayV = Math.cos(wavePhase * 7.5 + v * 40.0) * 0.003 * normH;
          // Structural collapse height reduction for catastrophic MMI
          if (normH > 0.75) {
            heightM *= 0.65;
          }
        } else if (hazardType === 'cyclone' && physicsEnabled && isImp) {
          swayU = Math.sin(wavePhase * 5.0) * 0.002 * normH;
        } else if (hazardType === 'landslide' && isImp && normH > 0.4) {
          swayU = 0.0025 * normH; // Slope displacement tilt
        }

        let col = 'rgba(56, 189, 248, 0.85)'; // Default intact cyan
        if (isImp) {
          if (hazardType === 'wildfire') {
            col = normH > 0.5 ? '#ef4444' : '#f97316';
          } else if (hazardType === 'earthquake') {
            col = normH > 0.6 ? '#ef4444' : '#f59e0b';
          } else if (hazardType === 'landslide') {
            col = normH > 0.5 ? '#78350f' : '#b45309';
          } else if (hazardType === 'cyclone') {
            col = normH > 0.5 ? '#a855f7' : '#06b6d4';
          } else {
            col = '#ef4444'; // flooded
          }
        }

        const base = project(u, v, groundE + bldgDispZ);
        const top = project(u + swayU, v + swayV, groundE + bldgDispZ + heightM);

        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.strokeStyle = col;
        ctx.lineWidth = isImp ? 3.5 : 2.5;
        ctx.stroke();

        // Cap square at roof height
        ctx.fillStyle = col;
        ctx.fillRect(top.x - 2.5, top.y - 2.5, 5, 5);

        // Hazard-specific building effects
        if (isImp && physicsEnabled) {
          if (hazardType === 'flood') {
            // Water impact pulse ring
            const pulse = (Math.sin(wavePhase * 4.0 + u * 20.0) + 1) * 0.5;
            ctx.strokeStyle = `rgba(56, 189, 248, ${(0.4 + pulse * 0.5).toFixed(2)})`;
            ctx.lineWidth = 1;
            ctx.strokeRect(base.x - 4, base.y - 2, 8, 4);
          } else if (hazardType === 'wildfire' && normH > 0.15) {
            // Flickering fire tongue on the building rooftop
            const flameFlicker = Math.sin(wavePhase * 7.0 + u * 30.0) * 2.0;
            ctx.fillStyle = '#fef08a';
            ctx.beginPath();
            ctx.moveTo(top.x - 2, top.y);
            ctx.lineTo(top.x, top.y - 6 - flameFlicker);
            ctx.lineTo(top.x + 2, top.y);
            ctx.closePath();
            ctx.fill();
          } else if (hazardType === 'earthquake' && normH > 0.5) {
            // Seismic damage alert indicator
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
            ctx.lineWidth = 1;
            ctx.strokeRect(top.x - 4, top.y - 4, 8, 8);
          } else if (hazardType === 'landslide' && normH > 0.3) {
            // Mud splatter around foundation
            ctx.fillStyle = '#78350f';
            ctx.fillRect(base.x - 4, base.y - 1, 8, 3);
          }
        }
      });
    }

    // ─── Render Hovered Tile Subtle Highlight ───
    if (hoveredTile && (!selectedTile || hoveredTile.r !== selectedTile.r || hoveredTile.c !== selectedTile.c)) {
      const hr = hoveredTile.r;
      const hc = hoveredTile.c;
      if (hr >= 0 && hr < rows - 1 && hc >= 0 && hc < cols - 1) {
        const u0 = hc / (cols - 1);
        const u1 = (hc + 1) / (cols - 1);
        const v0 = hr / (rows - 1);
        const v1 = (hr + 1) / (rows - 1);
        const e00 = elevGrid[hr]?.[hc] ?? minElev;
        const e10 = elevGrid[hr]?.[hc + 1] ?? minElev;
        const e11 = elevGrid[hr + 1]?.[hc + 1] ?? minElev;
        const e01 = elevGrid[hr + 1]?.[hc] ?? minElev;
        const hp00 = project(u0, v0, e00);
        const hp10 = project(u1, v0, e10);
        const hp11 = project(u1, v1, e11);
        const hp01 = project(u0, v1, e01);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(hp00.x, hp00.y);
        ctx.lineTo(hp10.x, hp10.y);
        ctx.lineTo(hp11.x, hp11.y);
        ctx.lineTo(hp01.x, hp01.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ─── Render Selected Tile with Floating Satellite Imagery Above It ───
    if (selectedTile) {
      const { r, c } = selectedTile;
      if (r >= 0 && r < rows - 1 && c >= 0 && c < cols - 1) {
        const u0 = c / (cols - 1);
        const u1 = (c + 1) / (cols - 1);
        const v0 = r / (rows - 1);
        const v1 = (r + 1) / (rows - 1);
        const uMid = (u0 + u1) / 2;
        const vMid = (v0 + v1) / 2;

        const e00 = elevGrid[r]?.[c] ?? minElev;
        const e10 = elevGrid[r]?.[c + 1] ?? minElev;
        const e11 = elevGrid[r + 1]?.[c + 1] ?? minElev;
        const e01 = elevGrid[r + 1]?.[c] ?? minElev;
        const avgElev = (e00 + e10 + e11 + e01) / 4;

        // Ground terrain points
        const gp00 = project(u0, v0, e00);
        const gp10 = project(u1, v0, e10);
        const gp11 = project(u1, v1, e11);
        const gp01 = project(u0, v1, e01);
        const gpMid = project(uMid, vMid, avgElev);

        // Elevated floating satellite plane points
        const floatElev = avgElev + satelliteHeight;
        const fp00 = project(u0, v0, floatElev);
        const fp10 = project(u1, v0, floatElev);
        const fp11 = project(u1, v1, floatElev);
        const fp01 = project(u0, v1, floatElev);
        const fpMid = project(uMid, vMid, floatElev);

        ctx.save();

        // 1. Ground Footprint highlight
        ctx.beginPath();
        ctx.moveTo(gp00.x, gp00.y);
        ctx.lineTo(gp10.x, gp10.y);
        ctx.lineTo(gp11.x, gp11.y);
        ctx.lineTo(gp01.x, gp01.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
        ctx.fill();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.2;
        ctx.stroke();

        // 2. Translucent vertical holographic laser volume / pillars
        ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
        ctx.beginPath();
        ctx.moveTo(gp00.x, gp00.y);
        ctx.lineTo(fp00.x, fp00.y);
        ctx.lineTo(fp10.x, fp10.y);
        ctx.lineTo(gp10.x, gp10.y);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(gp10.x, gp10.y);
        ctx.lineTo(fp10.x, fp10.y);
        ctx.lineTo(fp11.x, fp11.y);
        ctx.lineTo(gp11.x, gp11.y);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(gp11.x, gp11.y);
        ctx.lineTo(fp11.x, fp11.y);
        ctx.lineTo(fp01.x, fp01.y);
        ctx.lineTo(gp01.x, gp01.y);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(gp01.x, gp01.y);
        ctx.lineTo(fp01.x, fp01.y);
        ctx.lineTo(fp00.x, fp00.y);
        ctx.lineTo(gp00.x, gp00.y);
        ctx.closePath();
        ctx.fill();

        // Vertical corner tethers with glowing cyan dashed laser lines
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 4]);
        [
          [gp00, fp00],
          [gp10, fp10],
          [gp11, fp11],
          [gp01, fp01],
        ].forEach(([g, f]) => {
          ctx.beginPath();
          ctx.moveTo(g.x, g.y);
          ctx.lineTo(f.x, f.y);
          ctx.stroke();
        });

        // Center vertical tether
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.75)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(gpMid.x, gpMid.y);
        ctx.lineTo(fpMid.x, fpMid.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // 3. Floating 3D Satellite Plane
        ctx.beginPath();
        ctx.moveTo(fp00.x, fp00.y);
        ctx.lineTo(fp10.x, fp10.y);
        ctx.lineTo(fp11.x, fp11.y);
        ctx.lineTo(fp01.x, fp01.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fill();

        // Texture map satellite image if loaded
        if (aoiSatImg && aoiSatImg.complete && aoiSatImg.naturalWidth > 0) {
          drawTexturedQuad(ctx, aoiSatImg, fp00, fp10, fp11, fp01, u0, v0, u1, v1);
        }

        // Floating plane glowing border & corner reticles
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(fp00.x, fp00.y);
        ctx.lineTo(fp10.x, fp10.y);
        ctx.lineTo(fp11.x, fp11.y);
        ctx.lineTo(fp01.x, fp01.y);
        ctx.closePath();
        ctx.stroke();

        // Corner crosshair brackets
        [fp00, fp10, fp11, fp01].forEach((p) => {
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        });

        // Altitude indicator badge on center tether
        const midTetherX = (gpMid.x + fpMid.x) / 2;
        const midTetherY = (gpMid.y + fpMid.y) / 2;
        const altText = `▲ +${Math.round(satelliteHeight)}m ALTITUDE`;
        ctx.font = '700 9.5px "JetBrains Mono", monospace';
        const altW = ctx.measureText(altText).width;
        ctx.fillStyle = 'rgba(11, 19, 32, 0.9)';
        ctx.fillRect(midTetherX + 6, midTetherY - 8, altW + 10, 16);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.0;
        ctx.strokeRect(midTetherX + 6, midTetherY - 8, altW + 10, 16);
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(altText, midTetherX + 11, midTetherY + 4);

        ctx.restore();

        // Holographic tracker beam connecting 3D floating satellite to side inspection card
        const sideTargetX = width - 340;
        const sideTargetY = 95;
        if (sideTargetX > fpMid.x + 30) {
          ctx.save();
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
          ctx.lineWidth = 1.0;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(fpMid.x, fpMid.y);
          ctx.lineTo(sideTargetX, sideTargetY);
          ctx.stroke();

          // Radar connector point
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(sideTargetX, sideTargetY, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }, [
    yaw,
    pitch,
    zoom,
    zExaggeration,
    elevGrid,
    currentHazardGrid,
    nextHazardGrid,
    subFraction,
    rows,
    cols,
    minElev,
    maxElev,
    result,
    viewportSize,
    physicsEnabled,
    wavePhase,
    hazardType,
    peakVal,
    tileNumberMode,
    selectedTile,
    hoveredTile,
    satelliteHeight,
    renderNonce,
    aoiSatImg,
    showBuildings,
  ]);

  // Non-passive wheel listener: smooth, responsive exponential zoom across all mouse/trackpad modes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Normalize wheel delta across pixel/line/page modes
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33; // Line mode (Firefox / Windows wheel settings)
      else if (e.deltaMode === 2) dy *= 100; // Page mode

      // Responsive zoom calculation
      const zoomFactor = dy < 0 ? 1.15 : 0.87;
      setZoom((prev) => {
        if (Math.abs(dy) < 50) {
          // Trackpads or fine scroll gestures
          return Math.max(0.6, Math.min(6.5, +(prev * Math.exp(-dy * 0.003)).toFixed(3)));
        }
        return Math.max(0.6, Math.min(6.5, +(prev * zoomFactor).toFixed(2)));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Free orbit: drag anywhere — full 360° on yaw AND pitch
  const orbitBy = (dx: number, dy: number) => {
    setYaw((prev) => (prev + dx * 0.5 + 360) % 360);
    setPitch((prev) => (prev + dy * 0.5 + 360) % 360);
  };

  // Mouse drag to orbit (left click) or slide to zoom (right click, middle click, or Shift+drag)
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, button, .terrain3d-floating-timeline, .terrain3d-height-float, .terrain3d-zoombar, .terrain3d-actions, .terrain3d-floating-sat-card'
      )
    ) {
      return;
    }
    // Right click (2), middle click (1), or Shift/Alt + click = mouse zoom slide!
    const isZoom = e.button === 2 || e.button === 1 || (e.button === 0 && (e.shiftKey || e.altKey));
    dragModeRef.current = isZoom ? 'zoom' : 'orbit';

    setIsDragging(true);
    draggingRef.current = true;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    hasMovedDrag.current = false;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingRef.current) {
      const dist = Math.hypot(e.clientX - dragStartPos.current.x, e.clientY - dragStartPos.current.y);
      if (dist > 5) {
        hasMovedDrag.current = true;
      }
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.clientX, y: e.clientY };

      if (dragModeRef.current === 'zoom') {
        // Slide mouse vertically: moving up zooms in, moving down zooms out
        const zoomStep = Math.exp(-dy * 0.012);
        setZoom((prev) => Math.max(0.6, Math.min(6.5, +(prev * zoomStep).toFixed(2))));
      } else {
        orbitBy(dx, dy);
      }
    } else {
      // Check hover over 3D tiles for interactive cursor and preview outline
      const canvas = canvasRef.current;
      if (canvas && screenQuadsRef.current.length > 0) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let found: { r: number; c: number } | null = null;
        for (const q of screenQuadsRef.current) {
          if (isPointInQuad(mx, my, q.p00, q.p10, q.p11, q.p01)) {
            found = { r: q.r, c: q.c };
            break;
          }
        }
        setHoveredTile(found);
      }
    }
  };

  // Canvas click handler: selects clicked tile and activates floating satellite
  const handleCanvasClick = (e: React.MouseEvent) => {
    if (hasMovedDrag.current) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, button, .terrain3d-floating-timeline, .terrain3d-height-float, .terrain3d-zoombar, .terrain3d-actions, .terrain3d-floating-sat-card'
      )
    ) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    for (const q of screenQuadsRef.current) {
      if (isPointInQuad(clickX, clickY, q.p00, q.p10, q.p11, q.p01)) {
        if (selectedTile && selectedTile.r === q.r && selectedTile.c === q.c) {
          setSelectedTile(null);
        } else {
          setSelectedTile({ r: q.r, c: q.c });
        }
        return;
      }
    }
    // Clicked outside terrain quads
    setSelectedTile(null);
  };

  const endDrag = () => {
    setIsDragging(false);
    draggingRef.current = false;
    pinchRef.current = null;
  };

  // Touch handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, button, .terrain3d-floating-timeline, .terrain3d-height-float, .terrain3d-zoombar, .terrain3d-actions, .terrain3d-floating-sat-card'
      )
    ) {
      return;
    }
    if (e.touches.length === 2) {
      draggingRef.current = false;
      setIsDragging(false);
      pinchRef.current = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    } else if (e.touches.length === 1) {
      setIsDragging(true);
      draggingRef.current = true;
      dragStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      hasMovedDrag.current = false;
      lastMousePos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (pinchRef.current && pinchRef.current > 0) {
        const ratio = d / pinchRef.current;
        setZoom((prev) => Math.max(0.5, Math.min(4.0, prev * ratio)));
      }
      pinchRef.current = d;
    } else if (e.touches.length === 1 && draggingRef.current) {
      const dist = Math.hypot(e.touches[0].clientX - dragStartPos.current.x, e.touches[0].clientY - dragStartPos.current.y);
      if (dist > 5) {
        hasMovedDrag.current = true;
      }
      const dx = e.touches[0].clientX - lastMousePos.current.x;
      const dy = e.touches[0].clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      orbitBy(dx, dy);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!hasMovedDrag.current && e.changedTouches.length === 1 && canvasRef.current) {
      const touch = e.changedTouches[0];
      const rect = canvasRef.current.getBoundingClientRect();
      const clickX = touch.clientX - rect.left;
      const clickY = touch.clientY - rect.top;
      for (const q of screenQuadsRef.current) {
        if (isPointInQuad(clickX, clickY, q.p00, q.p10, q.p11, q.p01)) {
          setSelectedTile({ r: q.r, c: q.c });
          break;
        }
      }
    }
    endDrag();
  };

  // Keyboard orbit + zoom
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === 'ArrowLeft') setYaw((p) => (p - step + 360) % 360);
    else if (e.key === 'ArrowRight') setYaw((p) => (p + step) % 360);
    else if (e.key === 'ArrowUp') setPitch((p) => (p + step) % 360);
    else if (e.key === 'ArrowDown') setPitch((p) => (p - step + 360) % 360);
    else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(6.5, z * 1.12));
    else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0.6, z / 1.12));
    else return;
    e.preventDefault();
  };

  const formatTimelineTime = (val: number) => {
    if (timeUnit === 'seconds' || timeUnit === 's') {
      return `${Math.round(val)}s`;
    }
    if (timeUnit === 'minutes' || timeUnit === 'min') {
      const m = Math.floor(val);
      const s = Math.round((val - m) * 60);
      return `${m}m ${s.toString().padStart(2, '0')}s`;
    }
    const totalMinutes = Math.round(val * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')} h`;
  };

  const currentSimTime = (animFrame / Math.max(1, totalFrames - 1)) * totalSimulationTime;

  const formatTickLabel = (val: number) => {
    if (timeUnit === 'seconds' || timeUnit === 's') return `${Math.round(val)}s`;
    if (timeUnit === 'minutes' || timeUnit === 'min') return `${Math.round(val)}m`;
    const r = Math.round(val * 10) / 10;
    return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}h`;
  };

  const dynamicTicks = useMemo(() => {
    const rawLabels = (timestepLabels && timestepLabels.length > 0)
      ? timestepLabels
      : sim.timesteps && sim.timesteps.length > 1
      ? sim.timesteps.map((t) => formatTickLabel(t))
      : null;

    if (rawLabels && rawLabels.length > 0) {
      if (rawLabels.length <= 7) return rawLabels;
      const count = 5;
      return Array.from({ length: count }, (_, i) => {
        const idx = Math.round((i * (rawLabels.length - 1)) / (count - 1));
        return rawLabels[idx];
      });
    }

    const count = 5;
    const ticks: string[] = [];
    for (let i = 0; i < count; i++) {
      const val = (totalSimulationTime * i) / (count - 1);
      ticks.push(formatTickLabel(val));
    }
    return ticks;
  }, [timestepLabels, sim.timesteps, totalSimulationTime, timeUnit]);

  // Dynamic labels for physics button & timeline description
  const physicsLabel = useMemo(() => {
    if (hazardType === 'wildfire') return '🔥 Flames';
    if (hazardType === 'earthquake') return '⚡ Seismic';
    if (hazardType === 'cyclone') return '🌀 Vortex';
    if (hazardType === 'landslide') return '⛰️ Mudflow';
    return '🌊 Waves';
  }, [hazardType]);

  const timelineTitle = useMemo(() => {
    if (hazardType === 'wildfire') return 'Wildfire Pyro-Dynamics & Flame Spread';
    if (hazardType === 'earthquake') return 'Seismic Wave Propagation & Ground Motion';
    if (hazardType === 'cyclone') return 'Parametric Vortex Wind & Storm Surge';
    if (hazardType === 'landslide') return 'SHALSTAB Slope Stability & Mudflow Runout';
    return 'Hydrodynamic Flood Inundation • Real Physics';
  }, [hazardType]);

  return (
    <div className={`terrain3d-overlay-modal ${isFullscreen ? 'terrain3d-overlay-modal--fullscreen' : ''}`}>
      <div className={`terrain3d-container ${isFullscreen ? 'terrain3d-container--fullscreen' : ''}`}>
        {/* Header HUD */}
        <div className="terrain3d-header">
          <div className="terrain3d-actions" style={{ marginLeft: 'auto' }}>
            <button
              className="terrain3d-btn terrain3d-btn--reset"
              onClick={resetCamera}
              title="Reset camera angles and zoom"
            >
              ↺ Reset View
            </button>

            <button
              className={`terrain3d-btn terrain3d-btn--toggle ${show2DReference ? 'terrain3d-btn--active' : ''}`}
              onClick={() => setShow2DReference((v) => !v)}
              title="Toggle 2D Area Reference map pane"
            >
              🗺️ {show2DReference ? 'Hide 2D Map' : 'Show 2D Map'}
            </button>

            <button
              className={`terrain3d-btn terrain3d-btn--toggle ${tileNumberMode !== 'off' ? 'terrain3d-btn--active' : ''}`}
              onClick={() => {
                setTileNumberMode((prev) =>
                  prev === 'id' ? 'elev' : prev === 'elev' ? 'hazard' : prev === 'hazard' ? 'off' : 'id'
                );
              }}
              title="Cycle 3D tile corner micro-label: Tile # -> Elevation -> Live Hazard -> Off"
            >
              🏷️ {tileNumberMode === 'id' ? 'Tile #' : tileNumberMode === 'elev' ? 'Elev' : tileNumberMode === 'hazard' ? 'Hazard' : 'Tiles: Off'}
            </button>

            <button
              className={`terrain3d-btn terrain3d-btn--toggle ${showBuildings ? 'terrain3d-btn--active' : ''}`}
              onClick={() => setShowBuildings((v) => !v)}
              title={showBuildings ? 'Hide building spires (show terrain plane only)' : 'Show 3D buildings'}
            >
              🏢 {showBuildings ? 'Buildings: ON' : 'Buildings: OFF'}
            </button>

            <button
              className={`terrain3d-btn terrain3d-btn--toggle ${selectedTile ? 'terrain3d-btn--active' : ''}`}
              onClick={() => {
                if (selectedTile) {
                  setSelectedTile(null);
                } else {
                  setSelectedTile({ r: Math.floor((rows - 1) / 2), c: Math.floor((cols - 1) / 2) });
                }
              }}
              title="Select a tile & show floating satellite inspection at height"
            >
              🛰️ {selectedTile ? `Sat: Tile #${selectedTileData?.tileId ?? ''}` : 'Tile Satellite'}
            </button>

            <button
              className={`terrain3d-btn terrain3d-btn--fullscreen ${isFullscreen ? 'terrain3d-btn--active' : ''}`}
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? 'Exit full screen (revert to windowed modal)' : 'Expand to full screen'}
            >
              {isFullscreen ? '🗗 Windowed' : '⛶ Fullscreen'}
            </button>

            <button className="terrain3d-btn terrain3d-btn--close" onClick={onClose} title="Exit 3D Mode">
              ✕ Exit 3D
            </button>
          </div>
        </div>

        {/* Body: 2D reference left (optional/toggleable), 3D right */}
        <div className="terrain3d-body">
          {show2DReference && (
            <div className="terrain3d-snapshot-pane">
              {/* 1. Vector & Infrastructure Reference */}
              <div className="terrain3d-snapshot-section">
                <div className="terrain3d-snapshot-title">Selected Area &mdash; 2D Vector Reference</div>
                <AreaSnapshot result={result} currentFrame={Math.round(animFrame)} hazardType={hazardType} />
                <div className="terrain3d-snapshot-meta">
                  {(result.geodata?.roads?.length || 0).toLocaleString()} roads &bull;{' '}
                  {(result.impact?.buildings?.length || result.geodata?.buildings?.length || 0).toLocaleString()}{' '}
                  buildings &bull; {(result.impact?.facilities?.length || 0).toLocaleString()} facilities
                  <br />
                  Frame #{Math.round(animFrame)} &bull; North up
                </div>
              </div>

              {/* 2. Satellite 2D View of the Same Map */}
              <div className="terrain3d-snapshot-section" style={{ marginTop: 6 }}>
                <div className="terrain3d-snapshot-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>🛰️ Satellite 2D View</span>
                  <span style={{ fontSize: 9, background: 'rgba(56, 189, 248, 0.2)', color: '#38bdf8', padding: '1px 6px', borderRadius: 4, textTransform: 'none' }}>ArcGIS World Imagery</span>
                </div>
                <SatelliteAreaSnapshot result={result} currentFrame={Math.round(animFrame)} hazardType={hazardType} />
                <div className="terrain3d-snapshot-meta">
                  High-res satellite basemap &bull; Real-time hazard &amp; road overlay
                </div>
              </div>
            </div>
          )}

          <div className="terrain3d-view3d-pane">
            {/* 3D Viewport */}
            <div
              ref={viewportRef}
              className="terrain3d-viewport"
              tabIndex={0}
              role="application"
              aria-label="3D terrain viewport. Arrow keys orbit, plus and minus zoom."
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onKeyDown={handleKeyDown}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                cursor: isDragging
                  ? dragModeRef.current === 'zoom'
                    ? 'ns-resize'
                    : 'grabbing'
                  : hoveredTile
                  ? 'pointer'
                  : 'grab',
              }}
            >
              <canvas
                ref={canvasRef}
                className="terrain3d-canvas"
                onClick={handleCanvasClick}
                onContextMenu={(e) => e.preventDefault()}
              />

              {/* Floating Satellite Aerial Recon Card */}
              {selectedTile && selectedTileData && (
                <div
                  ref={floatingCardRef}
                  className="terrain3d-floating-sat-card"
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseMove={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                >
                  <div className="terrain3d-sat-card-header">
                    <div className="terrain3d-sat-card-title">
                      <span className="terrain3d-sat-card-icon">🛰️</span>
                      <div>
                        <div className="terrain3d-sat-card-heading">Tile #{selectedTileData.tileId} Aerial Recon</div>
                        <div className="terrain3d-sat-card-sub">
                          Grid [R{selectedTileData.r + 1}, C{selectedTileData.c + 1}] &bull; Hovering Satellite
                        </div>
                      </div>
                    </div>
                    <button
                      className="terrain3d-sat-card-close"
                      onClick={() => setSelectedTile(null)}
                      title="Deselect tile"
                      aria-label="Close satellite view"
                    >
                      ✕
                    </button>
                  </div>

                  {/* High-res Satellite Imagery Box */}
                  <div className="terrain3d-sat-card-img-box">
                    <TileSatelliteCanvas
                      aoiSatImg={aoiSatImg}
                      selectedTileData={selectedTileData}
                      cols={cols}
                      rows={rows}
                    />
                    <div className="terrain3d-sat-badge-top-left">OPTICAL SATELLITE (0.5M)</div>
                    <div className="terrain3d-sat-badge-top-right">
                      +{Math.round(satelliteHeight)}m ALT
                    </div>
                  </div>

                  {/* Fixed Satellite Altitude Info */}
                  <div className="terrain3d-sat-card-alt-box">
                    <div className="terrain3d-sat-alt-header">
                      <span>🛰️ Satellite Height (Altitude):</span>
                      <strong className="terrain3d-sat-alt-val">+85 meters</strong>
                    </div>
                  </div>

                  {/* Tile Telemetry Info */}
                  <div className="terrain3d-sat-card-stats">
                    <div className="terrain3d-sat-stat-row">
                      <span className="terrain3d-sat-stat-lbl">Elevation:</span>
                      <span className="terrain3d-sat-stat-val">{Math.round(selectedTileData.avgElev)}m MSL</span>
                    </div>
                    <div className="terrain3d-sat-stat-row">
                      <span className="terrain3d-sat-stat-lbl">Center Coordinates:</span>
                      <span className="terrain3d-sat-stat-val">
                        {selectedTileData.tileLat.toFixed(4)}&deg;N, {selectedTileData.tileLon.toFixed(4)}&deg;E
                      </span>
                    </div>
                    <div className="terrain3d-sat-stat-row">
                      <span className="terrain3d-sat-stat-lbl">Hazard Intensity:</span>
                      <span
                        className="terrain3d-sat-stat-val"
                        style={{ color: selectedTileData.normH > 0.3 ? '#f87171' : '#38bdf8' }}
                      >
                        {selectedTileData.avgHazard.toFixed(2)} ({Math.round(selectedTileData.normH * 100)}%)
                      </span>
                    </div>
                  </div>

                  {/* Footer Navigation */}
                  <div className="terrain3d-sat-card-nav">
                    <button
                      className="terrain3d-sat-nav-btn"
                      onClick={() => {
                        let prevC = selectedTile.c - 1;
                        let prevR = selectedTile.r;
                        if (prevC < 0) {
                          prevC = cols - 2;
                          prevR = (prevR - 1 + (rows - 1)) % (rows - 1);
                        }
                        setSelectedTile({ r: prevR, c: prevC });
                      }}
                      title="Step to previous tile"
                    >
                      ◀ Prev Tile
                    </button>
                    <button
                      className="terrain3d-sat-nav-btn"
                      onClick={() => {
                        let nextC = selectedTile.c + 1;
                        let nextR = selectedTile.r;
                        if (nextC >= cols - 1) {
                          nextC = 0;
                          nextR = (nextR + 1) % (rows - 1);
                        }
                        setSelectedTile({ r: nextR, c: nextC });
                      }}
                      title="Step to next tile"
                    >
                      Next Tile ▶
                    </button>
                    <button
                      className="terrain3d-sat-nav-btn terrain3d-sat-nav-btn--close"
                      onClick={() => setSelectedTile(null)}
                      title="Close"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              {/* Orbit HUD badge */}
              <div className="terrain3d-orbit-hud">
                <span>Yaw: {Math.round(yaw)}&deg;</span>
                <span>Pitch: {Math.round(pitch)}&deg;</span>
              </div>



              {/* ─── Floating 3D Timeline & Real-Time Physics Controller ─── */}
              <div
                className="terrain3d-floating-timeline"
                onMouseDown={(e) => e.stopPropagation()}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchMove={(e) => e.stopPropagation()}
              >
                <button
                  className="terrain3d-timeline-play-btn"
                  onClick={togglePlay}
                  title={localPlaying ? 'Pause Simulation' : 'Play Simulation'}
                  aria-label={localPlaying ? 'Pause simulation' : 'Play simulation'}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {localPlaying ? <IconPause size={14} color="#ffffff" /> : <IconPlay size={14} color="#ffffff" />}
                </button>

                <div className="terrain3d-timeline-scrubber-box">
                  <div className="terrain3d-timeline-label-row">
                    <span className="terrain3d-timeline-label">
                      {timelineTitle}
                    </span>
                    <span className="terrain3d-timeline-time-val">
                      {formatTimelineTime(currentSimTime)} / {timeUnit === 'seconds' ? `${Math.round(totalSimulationTime)}s` : timeUnit === 'minutes' ? `${Math.round(totalSimulationTime)} min` : `${totalSimulationTime.toFixed(0)}h`}
                    </span>
                  </div>
                  <input
                    type="range"
                    className="terrain3d-timeline-slider"
                    aria-label="Simulation timeline slider"
                    min={0}
                    max={Math.max(totalFrames - 1, 0.001)}
                    step={0.02}
                    value={animFrame}
                    onChange={(e) => handleScrub(parseFloat(e.target.value))}
                    onMouseDown={(e) => e.stopPropagation()}
                    onTouchStart={(e) => e.stopPropagation()}
                  />
                  <div className="terrain3d-timeline-ticks">
                    {dynamicTicks.map((lbl, idx) => (
                      <span key={idx}>{lbl}</span>
                    ))}
                  </div>
                </div>

                <div
                  className="terrain3d-speed-pill"
                  onClick={() => {
                    const nextSpeed = localSpeed === 1 ? 2 : localSpeed === 2 ? 4 : 1;
                    setLocalSpeed(nextSpeed);
                    setPlaySpeed?.(nextSpeed);
                  }}
                  title="Cycle simulation playback speed"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {localSpeed}&times;
                </div>

                <button
                  className={`terrain3d-physics-pill ${physicsEnabled ? 'terrain3d-physics-pill--active' : ''}`}
                  onClick={() => setPhysicsEnabled((v) => !v)}
                  title={`Toggle real-time ${hazardType} physics simulation`}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {physicsLabel}: {physicsEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Bottom Zoom and Controls Bar */}
            <div
              className="terrain3d-zoombar"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onWheel={(e) => {
                e.stopPropagation();
                const dy = e.deltaY;
                const factor = dy < 0 ? 1.15 : 0.87;
                setZoom((z) => Math.max(0.6, Math.min(6.5, +(z * factor).toFixed(2))));
              }}
            >
              <span>Zoom</span>
              <button
                type="button"
                className="terrain3d-zoom-btn"
                onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.25).toFixed(2)))}
                title="Zoom Out (-)"
              >
                &minus;
              </button>
              <input
                type="range"
                min="0.6"
                max="6.5"
                step="0.05"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                aria-label="3D zoom"
              />
              <button
                type="button"
                className="terrain3d-zoom-btn"
                onClick={() => setZoom((z) => Math.min(6.5, +(z + 0.25).toFixed(2)))}
                title="Zoom In (+)"
              >
                +
              </button>
              <strong>{zoom.toFixed(1)}&times;</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
