import { useState } from 'react';
import { BoundingBox, SatChange, SatDetection } from '../types';
import { geocodeLocation } from '../services/api';
import SatVisionPanel from './SatVisionPanel';
import SatMiniMap from './SatMiniMap';

const MUMBAI_DEMO_BBOX: BoundingBox = { south: 18.98, west: 72.81, north: 19.03, east: 72.86 };

interface SatVisionPageProps {
  bbox: BoundingBox | null;
  setBbox: (b: BoundingBox) => void;
  satDetections: SatDetection[] | null;
  setSatDetections: (d: SatDetection[] | null) => void;
  satChanges: SatChange[] | null;
  setSatChanges: (c: SatChange[] | null) => void;
  satLayersVisible: boolean;
  setSatLayersVisible: (v: boolean) => void;
  satCompareMix: number;
  setSatCompareMix: (v: number) => void;
  focusedPoint: { lat: number; lon: number; nonce: number } | null;
  setFocusedPoint: (p: { lat: number; lon: number; nonce: number } | null) => void;
  onBack: () => void;
}

export default function SatVisionPage(props: SatVisionPageProps) {
  const { bbox, setBbox, onBack } = props;
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await geocodeLocation(q);
      if (res?.bbox) {
        setBbox(res.bbox);
      } else {
        setSearchError('Place not found. Try another name or draw a box.');
      }
    } catch {
      setSearchError('Search failed. Try again or draw a box.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <button className="settings-back-btn" onClick={onBack} aria-label="Back to dashboard">
          ← Back
        </button>
        <div>
          <div className="settings-page-title">Satellite Vision</div>
          <div className="settings-page-sub">AI object detection and change detection over any area</div>
        </div>
      </div>
      <div className="settings-page-body satpage-body">
        <div className="satpage-grid">
          <div className="satpage-left">
            <div className="modern-facilities-card">
              <div className="facilities-card-header">
                <div className="facilities-card-title">Area of Interest</div>
              </div>
              <form className="satpage-search-row" onSubmit={handleSearch}>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search city or place…"
                  aria-label="Search city or place"
                />
                <button className="btn-execute-primary" type="submit" disabled={searching}>
                  {searching ? '…' : 'Search'}
                </button>
              </form>
              {searchError && (
                <div className="panel-standby-text" role="alert" style={{ color: '#f87171' }}>
                  {searchError}
                </div>
              )}
              <div className="satpage-form-actions">
                <button
                  className={drawMode ? 'btn-execute-primary' : 'btn-cancel'}
                  onClick={() => setDrawMode((v) => !v)}
                  aria-pressed={drawMode}
                >
                  {drawMode ? 'Drawing… click to stop' : 'Draw AOI box'}
                </button>
                <button className="btn-cancel" onClick={() => setBbox(MUMBAI_DEMO_BBOX)}>
                  Mumbai demo
                </button>
              </div>
              {bbox && (
                <div className="panel-standby-text">
                  Current: {bbox.south.toFixed(3)}, {bbox.west.toFixed(3)} → {bbox.north.toFixed(3)},{' '}
                  {bbox.east.toFixed(3)}
                </div>
              )}
            </div>
            <SatVisionPanel
              bbox={props.bbox}
              satDetections={props.satDetections}
              setSatDetections={props.setSatDetections}
              satChanges={props.satChanges}
              setSatChanges={props.setSatChanges}
              satLayersVisible={props.satLayersVisible}
              setSatLayersVisible={props.setSatLayersVisible}
              satCompareMix={props.satCompareMix}
              setSatCompareMix={props.setSatCompareMix}
              panelOpen={panelOpen}
              setPanelOpen={setPanelOpen}
              onLocateDetection={(lat, lon) => props.setFocusedPoint({ lat, lon, nonce: Date.now() })}
            />
          </div>
          <div className="satpage-map-wrap">
            <SatMiniMap
              bbox={props.bbox}
              detections={props.satDetections}
              changes={props.satChanges}
              layersVisible={props.satLayersVisible}
              compareMix={props.satCompareMix}
              focusedPoint={props.focusedPoint}
              drawMode={drawMode}
              onBboxSelect={(b) => {
                props.setBbox(b);
                setDrawMode(false);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
