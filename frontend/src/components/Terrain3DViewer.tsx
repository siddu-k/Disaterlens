import { useEffect, useRef, useState, useMemo } from 'react';
import { SimulationResult, RoadFeature, Facility } from '../types';

interface Terrain3DViewerProps {
  result: SimulationResult;
  currentFrame: number;
  onClose: () => void;
}

// Static 2D reference snapshot of the selected box (roads, buildings,
// facilities + current hazard frame, north-up). No interaction.
function AreaSnapshot({ result, currentFrame }: { result: SimulationResult; currentFrame: number }) {
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
    const grid = frames[Math.min(currentFrame, Math.max(0, frames.length - 1))] || [];
    const rows = sim.rows || grid.length;
    const cols = sim.cols || (grid[0] ? grid[0].length : 0);
    const sb = result.bbox;
    let peak = 0;
    grid.forEach((row) => row.forEach((v) => { if (v > peak) peak = v; }));
    peak = peak || 1;
    // Exact-size cells: tile the selected box edge-to-edge, no gaps or overlap
    const cw = W / Math.max(1, cols);
    const ch = H / Math.max(1, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r]?.[c] ?? 0;
        if (v <= 0.01) continue;
        const lat = sb.north - ((r + 0.5) / rows) * (sb.north - sb.south);
        const lon = sb.west + ((c + 0.5) / cols) * (sb.east - sb.west);
        const x = X(lon);
        const y = Y(lat);
        if (x < -cw || x > W + cw || y < -ch || y > H + ch) continue;
        ctx.fillStyle = `rgba(37, 99, 235, ${(0.15 + 0.65 * Math.min(1, v / peak)).toFixed(2)})`;
        ctx.fillRect(x - cw / 2, y - ch / 2, cw + 0.5, ch + 0.5);
      }
    }

    // Roads colored by backend status
    (result.geodata?.roads || []).forEach((road) => {
      if (!road.coords || road.coords.length < 2) return;
      ctx.beginPath();
      road.coords.forEach((pt, i) => {
        const x = X(pt[0]);
        const y = Y(pt[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle =
        road.status === 'closed' ? '#f87171' : road.status === 'restricted' ? '#fbbf24' : 'rgba(16, 185, 129, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });

    // Buildings as dots (red when hit)
    const buildings = result.impact?.buildings || result.geodata?.buildings || [];
    buildings.forEach((bldg: any) => {
      const cent = bldg.centroid;
      if (!cent) return;
      ctx.fillStyle = bldg.flooded || bldg.affected ? '#f87171' : 'rgba(148, 163, 184, 0.6)';
      ctx.fillRect(X(cent.lon) - 1, Y(cent.lat) - 1, 2, 2);
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
  }, [result, currentFrame, box, W, H]);

  return <canvas ref={snapRef} width={W} height={H} className="terrain3d-snapshot-canvas" />;
}

export default function Terrain3DViewer({ result, currentFrame, onClose }: Terrain3DViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Free-orbit camera: yaw wraps 360°, pitch 0° (horizon) → 90° (top-down)
  const [yaw, setYaw] = useState<number>(45); // degrees
  const [pitch, setPitch] = useState<number>(35); // degrees
  const [zoom, setZoom] = useState<number>(1.2);
  const [zExaggeration, setZExaggeration] = useState<number>(3.5);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const draggingRef = useRef<boolean>(false);
  const lastMousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<number | null>(null);

  const sim = result.simulation;
  const elev = result.elevation;
  const rows = elev?.rows || sim.rows;
  const cols = elev?.cols || sim.cols;
  const minElev = elev?.min_elevation ?? 0;
  const maxElev = elev?.max_elevation ?? 50;

  // Retrieve or derive elevation grid
  const elevGrid: number[][] = useMemo(() => {
    if (elev?.grid && elev.grid.length > 0) return elev.grid;
    // Fallback if grid was synthetic
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

  // Current hazard depth frame
  const waterGrid: number[][] = useMemo(() => {
    const frames = sim.frames || [];
    const idx = Math.min(currentFrame, Math.max(0, frames.length - 1));
    return frames[idx] || [];
  }, [sim, currentFrame]);

  // Render 3D Canvas Engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set high-DPI canvas
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    // Background gradient: Atmospheric twilight GIS command center
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#0a0f1d');
    bgGrad.addColorStop(0.5, '#0d1730');
    bgGrad.addColorStop(1, '#080d1a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 3D Math setup
    const radYaw = (yaw * Math.PI) / 180;
    const radPitch = (pitch * Math.PI) / 180;
    const cosY = Math.cos(radYaw);
    const sinY = Math.sin(radYaw);
    const cosP = Math.cos(radPitch);
    const sinP = Math.sin(radPitch);

    const elevSpan = Math.max(1, maxElev - minElev);
    const centerX = width / 2;
    const centerY = height / 2 + 30;
    const baseScale = Math.min(width, height) * 0.38 * zoom;

    // Project 3D point (grid x, y, z) into 2D screen coordinates
    const project = (u: number, v: number, zMeters: number) => {
      // Normalize to [-1, 1]
      const nx = (u - 0.5) * 2;
      const ny = (v - 0.5) * 2;
      // Normalized z height with exaggeration
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

    // Color mapper: elevation bands with directional shading
    const getTerrainColor = (elevVal: number, slopeShade = 1.0) => {
      const t = Math.min(1.0, Math.max(0.0, (elevVal - minElev) / elevSpan));
      let r = 30, g = 58, b = 138;
      if (t < 0.15) {
        // Coastal lowlands / tidal plains
        r = 16; g = 80; b = 85;
      } else if (t < 0.35) {
        // Flat urban floor / green meadows
        r = 34; g = 139; b = 90;
      } else if (t < 0.65) {
        // Foothills & ridges
        r = 160; g = 140; b = 45;
      } else if (t < 0.85) {
        // Rocky summits
        r = 180; g = 100; b = 40;
      } else {
        // High terrain peaks
        r = 210; g = 190; b = 175;
      }
      r = Math.min(255, Math.max(0, Math.round(r * slopeShade)));
      g = Math.min(255, Math.max(0, Math.round(g * slopeShade)));
      b = Math.min(255, Math.max(0, Math.round(b * slopeShade)));
      return `rgb(${r}, ${g}, ${b})`;
    };

    // Construct quads for Painter's Algorithm (render from farthest to closest)
    interface Quad {
      r: number;
      c: number;
      depth: number;
    }

    const quads: Quad[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const u = (c + 0.5) / (cols - 1);
        const v = (r + 0.5) / (rows - 1);
        const e = elevGrid[r]?.[c] ?? minElev;
        const p = project(u, v, e);
        quads.push({ r, c, depth: p.depth });
      }
    }

    // Sort back-to-front (largest depth rendered first)
    quads.sort((a, b) => b.depth - a.depth);

    // Render Quads
    quads.forEach(({ r, c }) => {
      const u0 = c / (cols - 1);
      const u1 = (c + 1) / (cols - 1);
      const v0 = r / (rows - 1);
      const v1 = (r + 1) / (rows - 1);

      const e00 = elevGrid[r]?.[c] ?? minElev;
      const e10 = elevGrid[r]?.[c + 1] ?? minElev;
      const e11 = elevGrid[r + 1]?.[c + 1] ?? minElev;
      const e01 = elevGrid[r + 1]?.[c] ?? minElev;

      const p00 = project(u0, v0, e00);
      const p10 = project(u1, v0, e10);
      const p11 = project(u1, v1, e11);
      const p01 = project(u0, v1, e01);

      // Simple directional shading based on local slope
      const dzX = (e10 - e00 + (e11 - e01)) * 0.5;
      const dzY = (e01 - e00 + (e11 - e10)) * 0.5;
      const slopeShade = Math.max(0.65, Math.min(1.35, 1.0 + (dzX * 0.04 - dzY * 0.03)));

      const avgElev = (e00 + e10 + e11 + e01) / 4;
      const w00 = waterGrid[r]?.[c] ?? 0;
      const w10 = waterGrid[r]?.[c + 1] ?? 0;
      const w11 = waterGrid[r + 1]?.[c + 1] ?? 0;
      const w01 = waterGrid[r + 1]?.[c] ?? 0;
      const avgWater = (w00 + w10 + w11 + w01) / 4;

      // Draw Terrain Face
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();

      ctx.fillStyle = getTerrainColor(avgElev, slopeShade);
      ctx.fill();

      ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
      ctx.lineWidth = 0.6;
      ctx.stroke();

      // Render 3D Water / Hazard Plane if flooded
      if (avgWater > 0.03) {
        const wp00 = project(u0, v0, e00 + w00);
        const wp10 = project(u1, v0, e10 + w10);
        const wp11 = project(u1, v1, e11 + w11);
        const wp01 = project(u0, v1, e01 + w01);

        ctx.beginPath();
        ctx.moveTo(wp00.x, wp00.y);
        ctx.lineTo(wp10.x, wp10.y);
        ctx.lineTo(wp11.x, wp11.y);
        ctx.lineTo(wp01.x, wp01.y);
        ctx.closePath();

        const alpha = Math.min(0.85, 0.45 + (avgWater / 3.0) * 0.4);
        ctx.fillStyle = `rgba(37, 99, 235, ${alpha})`;
        ctx.fill();

        ctx.strokeStyle = 'rgba(147, 197, 253, 0.6)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    });

    // Render 3D Roads Network
    {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      (result.geodata?.roads || []).forEach((road: RoadFeature) => {
        if (road.coords.length < 2) return;
        ctx.beginPath();
        road.coords.forEach((coord, i) => {
          const u = (coord[0] - b.west) / lonSpan;
          const v = (b.north - coord[1]) / latSpan;
          const r = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
          const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
          const e = (elevGrid[r]?.[c] ?? minElev) + 0.3; // slight elevation offset

          const p = project(u, v, e);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });

        const isClosed = road.status === 'closed';
        ctx.strokeStyle = isClosed ? '#ef4444' : '#10b981';
        ctx.lineWidth = isClosed ? 2.5 : 1.5;
        ctx.stroke();
      });
    }

    // Render 3D Facilities Beacons
    {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      (result.impact?.facilities || []).forEach((f: Facility) => {
        const u = (f.lon - b.west) / lonSpan;
        const v = (b.north - f.lat) / latSpan;
        const r = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
        const groundE = elevGrid[r]?.[c] ?? minElev;

        const groundP = project(u, v, groundE);
        const airP = project(u, v, groundE + 8 * zExaggeration);

        // Vertical drop line
        ctx.beginPath();
        ctx.moveTo(groundP.x, groundP.y);
        ctx.lineTo(airP.x, airP.y);
        ctx.strokeStyle = f.type === 'hospital' ? '#f87171' : '#34d399';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Glowing 3D Beacon Node
        ctx.beginPath();
        ctx.arc(airP.x, airP.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = f.type === 'hospital' ? '#ef4444' : '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    // Render 3D Buildings as extruded damage columns (full selection, affected first)
    {
      const b = result.bbox;
      const latSpan = Math.max(0.001, b.north - b.south);
      const lonSpan = Math.max(0.001, b.east - b.west);

      const buildings = [...(result.impact?.buildings || [])]
        .sort(
          (x: any, y: any) =>
            Number(y.flooded || y.affected) - Number(x.flooded || x.affected)
        );

      buildings.forEach((bd: any) => {
        const cent = bd.centroid;
        if (!cent || typeof cent.lat !== 'number' || typeof cent.lon !== 'number') return;
        const u = (cent.lon - b.west) / lonSpan;
        const v = (b.north - cent.lat) / latSpan;
        if (u < 0 || u > 1 || v < 0 || v > 1) return;
        const r = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
        const groundE = elevGrid[r]?.[c] ?? minElev;
        const heightM = Math.max(1.5, bd.height_m || (bd.levels || 1) * 3.2);

        const base = project(u, v, groundE);
        const top = project(u, v, groundE + heightM);

        const hit = bd.flooded || bd.affected;
        const col = hit ? '#f87171' : 'rgba(56, 189, 248, 0.85)';

        // Vertical damage column (constant screen width reads correctly from any yaw)
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(top.x, top.y);
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.stroke();

        // Cap square at roof height
        ctx.fillStyle = col;
        ctx.fillRect(top.x - 2.5, top.y - 2.5, 5, 5);
      });
    }
  }, [
    yaw,
    pitch,
    zoom,
    zExaggeration,
    elevGrid,
    waterGrid,
    rows,
    cols,
    minElev,
    maxElev,
    result,
  ]);

  // Non-passive wheel listener: smooth exponential zoom without browser warnings
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((prev) => Math.max(0.5, Math.min(4.0, prev * Math.exp(-e.deltaY * 0.0012))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Free orbit: drag anywhere — full 360° on yaw AND pitch (flip over the top / underneath)
  const orbitBy = (dx: number, dy: number) => {
    setYaw((prev) => (prev + dx * 0.5 + 360) % 360);
    setPitch((prev) => (prev + dy * 0.5 + 360) % 360);
  };

  // Mouse drag to orbit
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    draggingRef.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    orbitBy(dx, dy);
  };

  const endDrag = () => {
    setIsDragging(false);
    draggingRef.current = false;
    pinchRef.current = null;
  };

  // Touch: 1 finger orbits, 2-finger pinch zooms
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      draggingRef.current = false;
      setIsDragging(false);
      pinchRef.current = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    } else if (e.touches.length === 1) {
      draggingRef.current = true;
      setIsDragging(true);
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
      const dx = e.touches[0].clientX - lastMousePos.current.x;
      const dy = e.touches[0].clientY - lastMousePos.current.y;
      lastMousePos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      orbitBy(dx, dy);
    }
  };

  // Keyboard orbit + zoom (viewport is focusable)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === 'ArrowLeft') setYaw((p) => (p - step + 360) % 360);
    else if (e.key === 'ArrowRight') setYaw((p) => (p + step) % 360);
    else if (e.key === 'ArrowUp') setPitch((p) => (p + step) % 360);
    else if (e.key === 'ArrowDown') setPitch((p) => (p - step + 360) % 360);
    else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4.0, z * 1.12));
    else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0.5, z / 1.12));
    else return;
    e.preventDefault();
  };

  return (
    <div className="terrain3d-overlay-modal">
      <div className="terrain3d-container">
        {/* Header HUD */}
        <div className="terrain3d-header">
          <div className="terrain3d-actions" style={{ marginLeft: 'auto' }}>
            <button className="terrain3d-btn terrain3d-btn--close" onClick={onClose} title="Close 3D Mode">
              ✕ Exit 3D
            </button>
          </div>
        </div>

        {/* Body: 2D reference left, 3D right */}
        <div className="terrain3d-body">
          <div className="terrain3d-snapshot-pane">
            <div className="terrain3d-snapshot-title">Selected Area — 2D Reference</div>
            <AreaSnapshot result={result} currentFrame={currentFrame} />
            <div className="terrain3d-snapshot-meta">
              {(result.geodata?.roads?.length || 0).toLocaleString()} roads •{' '}
              {(result.impact?.buildings?.length || result.geodata?.buildings?.length || 0).toLocaleString()}{' '}
              buildings • {(result.impact?.facilities?.length || 0).toLocaleString()} facilities
              <br />
              Frame #{currentFrame} • North up
            </div>
          </div>
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
          onTouchEnd={endDrag}
          onKeyDown={handleKeyDown}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <canvas ref={canvasRef} className="terrain3d-canvas" />

          {/* Vertical height adjuster */}
          <div className="terrain3d-height-float" title="Vertical height exaggeration">
            <span>Height</span>
            <input
              type="range"
              min="1"
              max="8"
              step="0.5"
              value={zExaggeration}
              onChange={(e) => setZExaggeration(parseFloat(e.target.value))}
              className="terrain3d-height-range"
              aria-label="Vertical height exaggeration"
            />
            <strong className="terrain3d-height-val">{zExaggeration.toFixed(1)}×</strong>
          </div>


          </div>
          <div className="terrain3d-zoombar">
            <span>Zoom</span>
            <input
              type="range"
              min="0.5"
              max="4"
              step="0.1"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="3D zoom"
            />
            <strong>{zoom.toFixed(1)}×</strong>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
