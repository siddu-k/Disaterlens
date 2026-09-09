import { useState } from 'react';
import { BoundingBox, SatChange, SatDetection, SatSnapshot, SatStats } from '../types';
import { compareSnapshots, detectObjects, listSnapshots } from '../services/api';
import { IconEye, IconEyeOff, IconLocationPin, IconSatellite } from './Icons';

export const SAT_OBJECT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'building', label: 'Buildings' },
  { value: 'road', label: 'Roads' },
  { value: 'water', label: 'Water' },
  { value: 'tree', label: 'Trees' },
  { value: 'solar', label: 'Solar' },
];

interface SatVisionPanelProps {
  bbox: BoundingBox | null;
  satDetections: SatDetection[] | null;
  setSatDetections: (d: SatDetection[] | null) => void;
  satChanges: SatChange[] | null;
  setSatChanges: (c: SatChange[] | null) => void;
  satLayersVisible: boolean;
  setSatLayersVisible: (v: boolean) => void;
  satCompareMix: number;
  setSatCompareMix: (v: number) => void;
  onLocateDetection: (lat: number, lon: number) => void;
  onResultCount?: (n: number) => void;
  panelOpen?: boolean;
  setPanelOpen?: (v: boolean) => void;
}

export default function SatVisionPanel({
  bbox,
  satDetections,
  setSatDetections,
  satChanges,
  setSatChanges,
  satLayersVisible,
  setSatLayersVisible,
  satCompareMix,
  setSatCompareMix,
  onLocateDetection,
  onResultCount,
  panelOpen: panelOpenProp,
  setPanelOpen: setPanelOpenProp,
}: SatVisionPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const panelOpen = panelOpenProp ?? internalOpen;
  const setPanelOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? (v as (prev: boolean) => boolean)(panelOpen) : v;
    if (setPanelOpenProp) setPanelOpenProp(next);
    else setInternalOpen(next);
  };
  const [detectOpen, setDetectOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [modelMode, setModelMode] = useState<'hybrid' | 'osm-vector'>('hybrid');
  const [objectTypes, setObjectTypes] = useState<string[]>(['building', 'road', 'water', 'tree', 'solar']);
  const [detectLoading, setDetectLoading] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [stats, setStats] = useState<SatStats | null>(null);
  const [snapshots, setSnapshots] = useState<SatSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [snapshotA, setSnapshotA] = useState('');
  const [snapshotB, setSnapshotB] = useState('');
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareSummary, setCompareSummary] = useState<{
    new_buildings: number;
    removed_buildings: number;
    new_total: number;
    removed_total: number;
    vegetation_change_pct: number;
    water_change_pct: number;
    built_up_change_pct: number;
    total_changes: number;
  } | null>(null);

  const toggleType = (value: string) => {
    setObjectTypes((prev) =>
      prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]
    );
  };

  const handleDetect = async () => {
    if (!bbox) return;
    setDetectLoading(true);
    setDetectError(null);
    try {
      const res = await detectObjects(bbox, objectTypes, modelMode);
      setSatDetections(res.detections || []);
      setStats(res.stats || null);
      if (onResultCount) onResultCount(res.detections?.length ?? 0);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetectLoading(false);
    }
  };

  const handleLoadSnapshots = async () => {
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const list = await listSnapshots(bbox);
      setSnapshots(list);
    } catch (err) {
      setSnapshotsError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      setSnapshotsLoading(false);
    }
  };

  const handleExpandDiff = () => {
    const next = !diffOpen;
    setDiffOpen(next);
    if (next && snapshots.length === 0 && !snapshotsLoading) {
      void handleLoadSnapshots();
    }
  };

  const handleCompare = async () => {
    if (!snapshotA || !snapshotB || snapshotA === snapshotB) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const res = await compareSnapshots(snapshotA, snapshotB);
      setSatChanges(res.changes || []);
      setCompareSummary(res.summary || null);
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : 'Compare failed');
    } finally {
      setCompareLoading(false);
    }
  };

  const canCompare = snapshotA !== '' && snapshotB !== '' && snapshotA !== snapshotB && !compareLoading;

  return (
    <div className="modern-facilities-card" id="satvision-card">
      <div className="facilities-card-header">
        <div className="facilities-card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconSatellite size={14} />
          <span>Satellite Vision</span>
        </div>
        <button
          className="facilities-view-all-btn"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? 'Collapse satellite vision panel' : 'Expand satellite vision panel'}
        >
          {panelOpen ? 'Hide' : 'Show'}
        </button>
      </div>

      {panelOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#94a3b8', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={satLayersVisible}
              onChange={(e) => setSatLayersVisible(e.target.checked)}
              aria-label="Show satellite layers on map"
            />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {satLayersVisible ? <IconEye size={13} /> : <IconEyeOff size={13} />}
              Show satellite layers on map
            </span>
          </label>

          {/* ── AI Object Detection ── */}
          <div>
            <button
              className="facilities-view-all-btn"
              onClick={() => setDetectOpen((v) => !v)}
              aria-expanded={detectOpen}
              aria-label={detectOpen ? 'Collapse AI object detection' : 'Expand AI object detection'}
              style={{ marginBottom: 6 }}
            >
              {detectOpen ? 'Hide AI Object Detection' : 'Show AI Object Detection'}
            </button>
            {detectOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 4, background: '#0a0f1d', padding: 2, borderRadius: 6, border: '1px solid #1e293b' }}>
                  <button
                    type="button"
                    onClick={() => setModelMode('hybrid')}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      fontSize: 10.5,
                      fontWeight: modelMode === 'hybrid' ? 600 : 400,
                      background: modelMode === 'hybrid' ? '#1e293b' : 'transparent',
                      color: modelMode === 'hybrid' ? '#38bdf8' : '#94a3b8',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                    title="Real-time optical satellite AI (ArcGIS) fused with OSM. Detects water, trees, solar, and unmapped buildings."
                  >
                    ✦ Optical AI Vision (Hybrid)
                  </button>
                  <button
                    type="button"
                    onClick={() => setModelMode('osm-vector')}
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      fontSize: 10.5,
                      fontWeight: modelMode === 'osm-vector' ? 600 : 400,
                      background: modelMode === 'osm-vector' ? '#1e293b' : 'transparent',
                      color: modelMode === 'osm-vector' ? '#38bdf8' : '#94a3b8',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                    title="Pure OpenStreetMap vector data baseline"
                  >
                    OSM Vector Only
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {SAT_OBJECT_OPTIONS.map((opt) => (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: '#cbd5e1', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={objectTypes.includes(opt.value)}
                        onChange={() => toggleType(opt.value)}
                        aria-label={`Detect ${opt.label}`}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
                <button
                  className="btn-run-simulation-primary"
                  onClick={handleDetect}
                  disabled={!bbox || detectLoading}
                  aria-label="Run satellite object detection"
                  title={!bbox ? 'Draw an Area of Interest (AOI) on the map first' : 'Run satellite object detection'}
                >
                  {detectLoading ? 'Detecting…' : 'Detect'}
                </button>
                {!bbox && (
                  <div className="panel-standby-text">Draw an Area of Interest (AOI) on the map to enable detection.</div>
                )}
                {detectError && (
                  <div className="panel-standby-text" role="alert" style={{ color: '#f87171' }}>{detectError}</div>
                )}
                {stats && (
                  <div style={{ fontSize: 11.5, color: '#cbd5e1', lineHeight: 1.5 }}>
                    <div>Total: <strong style={{ color: '#f1f5f9' }}>{stats.total}</strong>
                      {' '}• Area: <strong style={{ color: '#f1f5f9' }}>{Math.round(stats.area_covered_sqm).toLocaleString()} m²</strong>
                      {' '}• Mean conf: <strong style={{ color: '#f1f5f9' }}>{(stats.mean_confidence * 100).toFixed(1)}%</strong>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {Object.entries(stats.by_type || {}).map(([k, v]) => (
                        <span key={k} className="genai-param-chip">{k}: <strong>{v}</strong></span>
                      ))}
                    </div>
                  </div>
                )}
                {satDetections && satDetections.length > 0 && (
                  <div className="facilities-list satvision-scroll-list">
                    {satDetections.slice(0, 100).map((d, idx) => (
                      <button
                        key={String(d.id) || idx}
                        className="facility-list-row satvision-row"
                        onClick={() => onLocateDetection(d.lat, d.lon)}
                        aria-label={`Locate ${d.type} detection at ${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`}
                        title={`${d.type} • conf ${(d.confidence * 100).toFixed(0)}% • ${d.source || 'OpenStreetMap'} — click to locate`}
                      >
                        <span className="facility-list-left" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <IconLocationPin size={13} />
                            <span className="facility-list-name">{String(d.type)} • {(d.confidence * 100).toFixed(0)}%</span>
                          </span>
                          {d.source && (
                            <span style={{ fontSize: 9.5, color: d.source.includes('Optical') ? '#38bdf8' : '#94a3b8', paddingLeft: 17 }}>
                              {d.source.includes('Unmapped') ? '✦ Satellite Unmapped' : d.source.includes('Optical') ? '✦ Satellite AI' : 'OSM Vector'}
                            </span>
                          )}
                        </span>
                        <span className="facility-list-right">
                          {d.area_sqm != null ? `${Math.round(d.area_sqm)} m²` : `${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Satellite Difference ── */}
          <div>
            <button
              className="facilities-view-all-btn"
              onClick={handleExpandDiff}
              aria-expanded={diffOpen}
              aria-label={diffOpen ? 'Collapse satellite difference' : 'Expand satellite difference'}
              style={{ marginBottom: 6 }}
            >
              {diffOpen ? 'Hide Satellite Difference' : 'Show Satellite Difference'}
            </button>
            {diffOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    className="wildfire-select-input"
                    value={snapshotA}
                    onChange={(e) => setSnapshotA(e.target.value)}
                    aria-label="Before snapshot"
                    style={{ flex: 1 }}
                  >
                    <option value="">Before…</option>
                    {snapshots.map((s) => (
                      <option key={s.id} value={s.id}>{s.id} • {s.created_at}</option>
                    ))}
                  </select>
                  <select
                    className="wildfire-select-input"
                    value={snapshotB}
                    onChange={(e) => setSnapshotB(e.target.value)}
                    aria-label="After snapshot"
                    style={{ flex: 1 }}
                  >
                    <option value="">After…</option>
                    {snapshots.map((s) => (
                      <option key={s.id} value={s.id}>{s.id} • {s.created_at}</option>
                    ))}
                  </select>
                  <button
                    className="facilities-view-all-btn"
                    onClick={handleLoadSnapshots}
                    disabled={snapshotsLoading}
                    aria-label="Refresh snapshots"
                    title="Refresh snapshots"
                  >
                    {snapshotsLoading ? '…' : 'Refresh'}
                  </button>
                </div>
                {snapshotsError && (
                  <div className="panel-standby-text" role="alert" style={{ color: '#f87171' }}>{snapshotsError}</div>
                )}
                {!snapshotsLoading && !snapshotsError && snapshots.length === 0 && (
                  <div className="panel-standby-text">No snapshots yet — run Detect first.</div>
                )}
                <button
                  className="btn-run-simulation-primary"
                  onClick={handleCompare}
                  disabled={!canCompare}
                  aria-label="Compare snapshots"
                  title={snapshotA === snapshotB && snapshotA !== '' ? 'Select two different snapshots' : 'Compare snapshots'}
                >
                  {compareLoading ? 'Comparing…' : 'Compare'}
                </button>
                {compareError && (
                  <div className="panel-standby-text" role="alert" style={{ color: '#f87171' }}>{compareError}</div>
                )}
                {compareSummary && (
                  <div className="impact-2x2-grid">
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.new_buildings}</div><div className="impact-2x2-label">New buildings</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.removed_buildings}</div><div className="impact-2x2-label">Removed buildings</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.new_total}</div><div className="impact-2x2-label">New total</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.removed_total}</div><div className="impact-2x2-label">Removed total</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.vegetation_change_pct.toFixed(1)}%</div><div className="impact-2x2-label">Vegetation</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.water_change_pct.toFixed(1)}%</div><div className="impact-2x2-label">Water</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.built_up_change_pct.toFixed(1)}%</div><div className="impact-2x2-label">Built-up</div></div></div>
                    <div className="impact-2x2-tile"><div className="impact-2x2-info"><div className="impact-2x2-val">{compareSummary.total_changes}</div><div className="impact-2x2-label">Total changes</div></div></div>
                  </div>
                )}
                {compareSummary && (
                  <div className="satvision-mix-row">
                    <span>Before / After</span>
                    <input
                      type="range"
                      className="scenario-range-input"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(satCompareMix * 100)}
                      onChange={(e) => setSatCompareMix(Number(e.target.value) / 100)}
                      aria-label="Before after crossfade mix"
                    />
                    <span>{Math.round(satCompareMix * 100)}%</span>
                  </div>
                )}
                {satChanges && satChanges.length > 0 && (
                  <div className="facilities-list satvision-scroll-list">
                    {satChanges.slice(0, 50).map((c, idx) => (
                      <button
                        key={String(c.id) || idx}
                        className="facility-list-row satvision-row"
                        onClick={() => onLocateDetection(c.lat, c.lon)}
                        aria-label={`Locate ${c.change} ${c.type} at ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`}
                        title={`${c.change} • ${c.type} — click to locate`}
                      >
                        <span className="facility-list-left">
                          <IconLocationPin size={13} />
                          <span className="facility-list-name">{c.change} • {String(c.type)}</span>
                        </span>
                        <span className="facility-list-right">{c.lat.toFixed(3)}, {c.lon.toFixed(3)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
