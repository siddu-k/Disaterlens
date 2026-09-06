import { useState, useRef, useCallback, useEffect } from 'react';
import './index.css';
import {
  SimulationResult,
  DisasterType,
  BoundingBox,
  ScenarioPreset,
  RoadFeature,
  Facility,
  ProvenanceResponse,
} from './types';
import {
  runSimulation,
  healthCheck,
  getPresets,
  getProvenance,
  parseNaturalLanguageScenario,
  geocodeLocation,
  reverseGeocodeLocation,
} from './services/api';
import MapView from './components/MapView';
import {
  IconFlood,
  IconCyclone,
  IconHeatwave,
  IconEarthquake,
  IconLandslide,
  IconLocationPin,
  IconSearch,
  IconPopulation,
  IconBuilding,
  IconRoad,
  IconAlertTriangle,
  IconPolice,
  IconHospital,
  IconShelter,
  IconFireStation,
  IconSchool,
  IconMedicalCross,
  IconInsight,
  IconPlay,
  IconPause,
} from './components/Icons';

const DEFAULT_MUMBAI_BBOX: BoundingBox = {
  south: 18.9800,
  west: 72.8150,
  north: 19.0350,
  east: 72.8650,
};

const DISASTER_PILLS: { type: DisasterType; icon: React.ReactNode; label: string }[] = [
  { type: 'flood', icon: <IconFlood size={14} />, label: 'Flood' },
  { type: 'cyclone', icon: <IconCyclone size={14} />, label: 'Cyclone' },
  { type: 'wildfire', icon: <IconHeatwave size={14} />, label: 'Heatwave' },
  { type: 'earthquake', icon: <IconEarthquake size={14} />, label: 'Earthquake' },
  { type: 'landslide', icon: <IconLandslide size={14} />, label: 'Landslide' },
];

function App() {
  // State (Initialized clean: no auto-selected city or auto-scan on start)
  const [disasterType, setDisasterType] = useState<DisasterType>('flood');
  const [locationName, setLocationName] = useState('');
  const [bbox, setBbox] = useState<BoundingBox | null>(null);

  // Scenario Parameters
  const [rainfallMm, setRainfallMm] = useState(300);
  const [durationHours, setDurationHours] = useState(24);
  const [seaLevelSurge, setSeaLevelSurge] = useState(2.5);
  const [magnitude, setMagnitude] = useState(6.8);
  const [depthKm, setDepthKm] = useState(10.0);
  const [windSpeedKmh, setWindSpeedKmh] = useState(165);
  const [centralPressure, setCentralPressure] = useState(945);
  const [tempC, setTempC] = useState(36);
  const [humidityPct, setHumidityPct] = useState(20);

  // Simulation State
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [lastCompletedRun, setLastCompletedRun] = useState<{
    id: string;
    summary: string;
    disaster: string;
    time: string;
  } | null>(null);

  // Timeline State
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(1);
  const playIntervalRef = useRef<number | null>(null);

  // Map & Visual State
  const [mapMode, setMapMode] = useState<'satellite' | 'map'>('satellite');
  const [selectedRoad, setSelectedRoad] = useState<RoadFeature | null>(null);
  const [showEvacuationRoutes, setShowEvacuationRoutes] = useState(false);

  // Drawers & Modals
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [showProvenanceDrawer, setShowProvenanceDrawer] = useState(false);
  const [provenanceData, setProvenanceData] = useState<ProvenanceResponse | null>(null);
  const [nlPrompt, setNlPrompt] = useState('');
  const [nlParsing, setNlParsing] = useState(false);
  const [presets, setPresets] = useState<ScenarioPreset[]>([]);

  // Initial Load: Health Check, Presets
  useEffect(() => {
    healthCheck()
      .then((h) => {
        setBackendStatus('online');
      })
      .catch(() => setBackendStatus('offline'));

    getPresets().then((p) => setPresets(p)).catch(() => {});
    getProvenance('flood').then((prov) => setProvenanceData(prov)).catch(() => {});
  }, []);

  // Update Provenance when disaster changes
  useEffect(() => {
    getProvenance(disasterType).then((prov) => setProvenanceData(prov)).catch(() => {});
  }, [disasterType]);

  // Timeline playback loop
  useEffect(() => {
    if (isPlaying && result) {
      const totalFrames = result.simulation.frames.length;
      playIntervalRef.current = window.setInterval(() => {
        setCurrentFrame((prev) => {
          if (prev >= totalFrames - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 700 / playSpeed);
    }
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying, playSpeed, result]);

  const togglePlay = () => {
    if (!isPlaying && result && currentFrame >= result.simulation.frames.length - 1) {
      setCurrentFrame(0);
    }
    setIsPlaying(!isPlaying);
  };

  // Core Simulation Dispatcher
  const executeSimulation = async (overrides?: any) => {
    const targetBbox = overrides?.bbox || bbox;
    if (!targetBbox) {
      setError('Please draw an Area of Interest (AOI) on the map first.');
      return;
    }

    setLoading(true);
    setError(null);
    setShowEvacuationRoutes(false);
    setSelectedRoad(null);
    setCurrentFrame(0);
    setIsPlaying(false);

    try {
      setLoadingStep('Retrieving DEM topography & OSM infrastructure...');
      const targetDisaster = overrides?.disaster_type || disasterType;

      const simResult = await runSimulation({
        bbox: targetBbox,
        disaster_type: targetDisaster,
        location_name: overrides?.locationName || locationName,
        rainfall_mm: overrides?.rainfall_mm ?? rainfallMm,
        duration_hours: overrides?.duration_hours ?? durationHours,
        sea_level_surge_m: overrides?.sea_level_surge_m ?? seaLevelSurge,
        magnitude: overrides?.magnitude ?? magnitude,
        depth_km: overrides?.depth_km ?? depthKm,
        wind_speed_kmh: overrides?.wind_speed_kmh ?? windSpeedKmh,
        max_wind_kmh: overrides?.max_wind_kmh ?? overrides?.wind_speed_kmh ?? windSpeedKmh,
        central_pressure_hpa: overrides?.central_pressure_hpa ?? centralPressure,
        temperature_c: overrides?.temperature_c ?? tempC,
        relative_humidity_pct: overrides?.relative_humidity_pct ?? humidityPct,
        cumulative_rainfall_mm: overrides?.cumulative_rainfall_mm ?? overrides?.rainfall_mm ?? rainfallMm,
      });

      setResult(simResult);
      setCurrentFrame(0);
      setIsPlaying(false);

      setLastCompletedRun({
        id: simResult.run_uuid ? simResult.run_uuid.slice(0, 8) : 'sim',
        summary: targetDisaster === 'flood'
          ? `${overrides?.rainfall_mm ?? rainfallMm}mm Rain, +${overrides?.sea_level_surge_m ?? seaLevelSurge}m Surge (${overrides?.duration_hours ?? durationHours}h)`
          : targetDisaster === 'earthquake'
          ? `Mw ${overrides?.magnitude ?? magnitude} (${overrides?.depth_km ?? depthKm}km Depth)`
          : targetDisaster === 'cyclone'
          ? `${overrides?.wind_speed_kmh ?? windSpeedKmh} km/h Wind (${overrides?.central_pressure_hpa ?? centralPressure} hPa)`
          : targetDisaster === 'wildfire'
          ? `${overrides?.temperature_c ?? tempC}°C, ${overrides?.wind_speed_kmh ?? windSpeedKmh}km/h`
          : `${overrides?.rainfall_mm ?? rainfallMm}mm Rain`,
        disaster: targetDisaster,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });

      if (simResult.provenance) {
        setProvenanceData(simResult.provenance);
      }
      setLoadingStep('');
    } catch (err: any) {
      setError(err.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDisasterSelect = (type: DisasterType) => {
    setDisasterType(type);
  };

  const handleApplyPreset = (p: ScenarioPreset) => {
    setDisasterType(p.disaster_type);
    setLocationName(p.location_name);
    setBbox(p.bbox);
    if (p.parameters.rainfall_mm !== undefined) setRainfallMm(p.parameters.rainfall_mm);
    if (p.parameters.duration_hours !== undefined) setDurationHours(p.parameters.duration_hours);
    if (p.parameters.sea_level_surge_m !== undefined) setSeaLevelSurge(p.parameters.sea_level_surge_m);
    if (p.parameters.magnitude !== undefined) setMagnitude(p.parameters.magnitude);
    if (p.parameters.max_wind_kmh !== undefined) setWindSpeedKmh(p.parameters.max_wind_kmh);

    setShowScenarioModal(false);
    executeSimulation({
      bbox: p.bbox,
      disaster_type: p.disaster_type,
      locationName: p.location_name,
      ...p.parameters,
    });
  };

  const handleNaturalLanguageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nlPrompt.trim()) return;
    setNlParsing(true);
    try {
      const parsed = await parseNaturalLanguageScenario(nlPrompt, disasterType);
      if (parsed.disaster_type) setDisasterType(parsed.disaster_type);
      if (parsed.parameters?.rainfall_mm !== undefined) setRainfallMm(parsed.parameters.rainfall_mm);
      if (parsed.parameters?.duration_hours !== undefined) setDurationHours(parsed.parameters.duration_hours);
      if (parsed.parameters?.sea_level_surge_m !== undefined) setSeaLevelSurge(parsed.parameters.sea_level_surge_m);
      if (parsed.parameters?.magnitude !== undefined) setMagnitude(parsed.parameters.magnitude);
      if (parsed.parameters?.wind_speed_kmh !== undefined) setWindSpeedKmh(parsed.parameters.wind_speed_kmh);

      setShowScenarioModal(false);
      executeSimulation({
        disaster_type: parsed.disaster_type || disasterType,
        ...parsed.parameters,
      });
      setNlPrompt('');
    } catch (err: any) {
      alert('Could not parse scenario: ' + err.message);
    } finally {
      setNlParsing(false);
    }
  };

  const handleLocationSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!locationName.trim()) return;

    setLoading(true);
    setLoadingStep(`Locating "${locationName}" on map...`);
    try {
      const geo = await geocodeLocation(locationName);
      if (geo) {
        setLocationName(geo.name);
        setBbox(geo.bbox);
        setResult(null);
        setSelectedRoad(null);
      } else {
        alert(`Location "${locationName}" not found on OpenStreetMap. Try a city, region, or draw an area on the map.`);
      }
    } catch (err: any) {
      alert('Geocoding error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBboxSelection = async (newBbox: BoundingBox) => {
    const centerLat = (newBbox.south + newBbox.north) / 2;
    const centerLon = (newBbox.west + newBbox.east) / 2;
    let customLabel = `Selected AOI (${centerLat.toFixed(3)}, ${centerLon.toFixed(3)})`;
    setBbox(newBbox);
    setLocationName(customLabel);
    setResult(null);
    setSelectedRoad(null);

    try {
      const realName = await reverseGeocodeLocation(centerLat, centerLon);
      if (realName) {
        setLocationName(realName);
      }
    } catch {}
  };

  // Computed values
  const impact = result?.impact;
  const aiInsight = result?.ai_insight;
  const totalFrames = result?.simulation.frames.length || 0;
  const currentTime = result?.simulation.timesteps?.[currentFrame] ?? 0;
  const totalSimulationHours = result?.simulation.total_time_hours || durationHours;
  const roadStatus = impact?.road_status;
  const totalRoads = roadStatus?.total || 1;
  const openPct = Math.round(((roadStatus?.open || 0) / totalRoads) * 100);
  const restrictedPct = Math.round(((roadStatus?.restricted || 0) / totalRoads) * 100);
  const closedPct = Math.round(((roadStatus?.closed || 0) / totalRoads) * 100);

  const formatTimelineHours = (hoursVal: number) => {
    const totalMinutes = Math.round(hoursVal * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')} h`;
  };

  // Active Bbox and Center Coordinates for dynamic header badge
  // Active Bbox and Center Coordinates for dynamic header badge
  const activeBbox = result?.bbox || bbox;
  const centerLat = activeBbox ? (activeBbox.south + activeBbox.north) / 2 : null;
  const centerLon = activeBbox ? (activeBbox.west + activeBbox.east) / 2 : null;
  const latFormatted = centerLat !== null ? `${Math.abs(centerLat).toFixed(4)}° ${centerLat >= 0 ? 'N' : 'S'}` : '';
  const lonFormatted = centerLon !== null ? `${Math.abs(centerLon).toFixed(4)}° ${centerLon >= 0 ? 'E' : 'W'}` : '';
  const displayCoords = centerLat !== null && centerLon !== null ? `${latFormatted}, ${lonFormatted}` : 'No AOI Selected';
  const displayLocation = locationName || 'Select an AOI or City';

  // Facilities from real simulation or geodata
  const realFacilities = (impact?.facilities && impact.facilities.length > 0)
    ? impact.facilities
    : (result?.geodata?.facilities && result.geodata.facilities.length > 0 ? result.geodata.facilities : []);

  const displayFacilities = realFacilities.slice(0, 4);

  const getFacilityVisual = (typeOrName?: string) => {
    const t = (typeOrName || '').toLowerCase();
    if (t.includes('police') || t.includes('security') || t.includes('station')) {
      return { icon: <IconPolice size={15} color="#38bdf8" />, bg: 'rgba(2, 132, 199, 0.25)', color: '#38bdf8' };
    }
    if (t.includes('shelter') || t.includes('relief') || t.includes('camp')) {
      return { icon: <IconShelter size={15} color="#34d399" />, bg: 'rgba(16, 185, 129, 0.25)', color: '#34d399' };
    }
    if (t.includes('fire')) {
      return { icon: <IconFireStation size={15} color="#fb923c" />, bg: 'rgba(249, 115, 22, 0.25)', color: '#fb923c' };
    }
    if (t.includes('school') || t.includes('convent') || t.includes('college') || t.includes('high school')) {
      return { icon: <IconSchool size={15} color="#c084fc" />, bg: 'rgba(168, 85, 247, 0.25)', color: '#c084fc' };
    }
    if (t.includes('diagnostic') || t.includes('clinic')) {
      return { icon: <IconMedicalCross size={15} color="#38bdf8" />, bg: 'rgba(2, 132, 199, 0.25)', color: '#38bdf8' };
    }
    return { icon: <IconHospital size={15} color="#f87171" />, bg: 'rgba(239, 68, 68, 0.25)', color: '#f87171' };
  };

  return (
    <div className="app-root-layout">
      {/* ─── Left Sidebar ────────────────────────────────────────── */}
      <aside className="app-left-sidebar">
        <div>
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <path d="M16 3L4 9l12 6 12-6-12-6z" fill="#38bdf8" />
                <path d="M4 15l12 6 12-6" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 21l12 6 12-6" stroke="#0284c7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="sidebar-brand-title">DisasterLens</div>
              <div className="sidebar-brand-sub">Real Data. Real Impact.</div>
            </div>
          </div>

          <nav className="sidebar-nav">
            <button className="sidebar-nav-btn">
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9.5L12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 20V9.5z" />
                  <polyline points="9 21 9 12 15 12 15 21" />
                </svg>
              </span>
              <span>Overview</span>
            </button>
            <button className="sidebar-nav-btn sidebar-nav-btn--active">
              <div className="sidebar-active-icon-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
                  <line x1="8" y1="2" x2="8" y2="18" />
                  <line x1="16" y1="6" x2="16" y2="22" />
                </svg>
              </div>
              <span>Map &amp; Simulation</span>
            </button>
            <button className="sidebar-nav-btn" onClick={() => setShowScenarioModal(true)}>
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </span>
              <span>Scenarios</span>
            </button>
            <button className="sidebar-nav-btn" onClick={() => setShowProvenanceDrawer(true)}>
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              </span>
              <span>Data Sources</span>
            </button>
            <button className="sidebar-nav-btn" onClick={() => setShowProvenanceDrawer(true)}>
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  <polyline points="8 15 12 11 15 14 19 9" />
                </svg>
              </span>
              <span>Results</span>
            </button>
            <button className="sidebar-nav-btn" onClick={() => setShowProvenanceDrawer(true)}>
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </span>
              <span>Settings</span>
            </button>
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-wave-container">
            <svg width="100%" height="48" viewBox="0 0 180 50" fill="none">
              <path d="M0 25 C30 5, 60 45, 90 25 C120 5, 150 45, 180 25" stroke="#38bdf8" strokeWidth="1.6" strokeOpacity="0.4" />
              <path d="M0 32 C30 15, 60 48, 90 30 C120 12, 150 48, 180 28" stroke="#60a5fa" strokeWidth="1.2" strokeOpacity="0.3" />
              <path d="M0 18 C30 2, 60 40, 90 20 C120 2, 150 40, 180 18" stroke="#0ea5e9" strokeWidth="0.8" strokeOpacity="0.25" />
            </svg>
          </div>
          <div className="sidebar-tagline">
            Safer<br/>Communities<br/>Stronger<br/>Tomorrows
          </div>
        </div>
      </aside>

      {/* ─── Main Section (Header + Body + Footer) ───────────────── */}
      <div className="app-main-layout">
        {/* Top Header Bar */}
        <header className="app-top-header">
          <form onSubmit={handleLocationSearch} className="header-search-bar">
            <span className="header-search-icon">
              <IconSearch size={14} color="#8b949e" />
            </span>
            <input
              type="text"
              className="header-search-input"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              placeholder="Search for a city, place or coordinates..."
            />
          </form>

          <div className="header-meta-group">
            <div className="header-location-badge">
              <span className="header-loc-pin">
                <IconLocationPin size={15} color="#38bdf8" />
              </span>
              <div>
                <div className="header-loc-name">{displayLocation}</div>
                <div className="header-loc-coords">{displayCoords}</div>
              </div>
            </div>


          </div>
        </header>

        {/* Workspace Body */}
        <main className="app-workspace-body">
          {/* Map Container */}
          <div className="workspace-map-container">
            <MapView
              mapMode={mapMode}
              setMapMode={setMapMode}
              onBboxSelect={handleBboxSelection}
              result={result}
              currentFrame={currentFrame}
              bbox={bbox}
              showEvacuationRoutes={showEvacuationRoutes}
              selectedRoad={selectedRoad}
              setSelectedRoad={setSelectedRoad}
              disasterType={disasterType}
              setDisasterType={handleDisasterSelect}
            />

            {/* Loading Overlay */}
            {loading && (
              <div className="map-loading-overlay">
                <div className="loading-pulsar" />
                <div className="loading-title">Calculating Scientific Disaster Simulation...</div>
                <div className="loading-sub">{loadingStep}</div>
              </div>
            )}

            {/* Floating Timeline Bar OVER Map (Matching reference image) */}
            <div className="map-bottom-floating-timeline">
              <button className="map-timeline-play-btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <IconPause size={13} color="#ffffff" /> : <IconPlay size={13} color="#ffffff" />}
              </button>

              <div className="map-timeline-scrubber-box">
                <div className="map-timeline-label">
                  Simulation Timeline ({totalSimulationHours.toFixed(0)} hours)
                </div>
                <input
                  type="range"
                  className="map-timeline-slider"
                  min={0}
                  max={Math.max(totalFrames - 1, 0)}
                  value={currentFrame}
                  onChange={(e) => {
                    setCurrentFrame(Number(e.target.value));
                    setIsPlaying(false);
                  }}
                />
                <div className="map-timeline-ticks">
                  <span>0h</span>
                  <span>3h</span>
                  <span>6h</span>
                  <span>9h</span>
                  <span>12h</span>
                  <span>15h</span>
                  <span>18h</span>
                  <span>21h</span>
                  <span>24h</span>
                </div>
              </div>

              <div className="map-timeline-time-badge">
                {formatTimelineHours(currentTime)}
              </div>

              <div className="map-timeline-speed-pill" onClick={() => setPlaySpeed(playSpeed === 1 ? 2 : playSpeed === 2 ? 4 : 1)}>
                <span>{playSpeed}x</span>
                <span className="speed-chevron">⌄</span>
              </div>
            </div>
          </div>

          {/* Right Control & Analytics Panel */}
          <aside className="workspace-right-panel">
            {/* Card 1: Scenario Overview */}
            <div className="modern-scenario-card">
              <div className="scenario-card-header">
                <span className="scenario-card-label">Scenario</span>
                <button className="scenario-change-btn" onClick={() => setShowScenarioModal(true)}>
                  Change
                </button>
              </div>
              <div className="scenario-title-row">
                <span>{disasterType === 'flood' ? '🌧️' : disasterType === 'cyclone' ? '🌀' : disasterType === 'earthquake' ? '🏚️' : disasterType === 'wildfire' ? '🔥' : '⛰️'}</span>
                <span>
                  {disasterType === 'flood'
                    ? `${durationHours}-hour Extreme Rainfall`
                    : disasterType === 'cyclone'
                    ? `${durationHours}-hour Cyclone Landfall`
                    : disasterType === 'earthquake'
                    ? `Mw ${magnitude} Severe Earthquake`
                    : disasterType === 'wildfire'
                    ? `${durationHours}-hour Extreme Heatwave`
                    : `${durationHours}-hour Monsoon Landslide`}
                </span>
              </div>
              <div className="scenario-sliders-group">
                {disasterType === 'flood' && (
                  <>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Total Rainfall</span>
                        <span className="scenario-slider-val">{rainfallMm} mm</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={20}
                        max={800}
                        step={10}
                        value={rainfallMm}
                        onChange={(e) => setRainfallMm(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Duration</span>
                        <span className="scenario-slider-val">{durationHours} hours</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={1}
                        max={72}
                        step={1}
                        value={durationHours}
                        onChange={(e) => setDurationHours(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Coastal Storm Surge (optional)</span>
                        <span className="scenario-slider-val">+{seaLevelSurge} m</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={0}
                        max={8}
                        step={0.5}
                        value={seaLevelSurge}
                        onChange={(e) => setSeaLevelSurge(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
                {disasterType === 'cyclone' && (
                  <>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Max Wind Speed</span>
                        <span className="scenario-slider-val">{windSpeedKmh} km/h</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={60}
                        max={280}
                        step={5}
                        value={windSpeedKmh}
                        onChange={(e) => setWindSpeedKmh(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Duration</span>
                        <span className="scenario-slider-val">{durationHours} hours</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={1}
                        max={72}
                        step={1}
                        value={durationHours}
                        onChange={(e) => setDurationHours(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Central Pressure</span>
                        <span className="scenario-slider-val">{centralPressure} hPa</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={900}
                        max={1000}
                        step={5}
                        value={centralPressure}
                        onChange={(e) => setCentralPressure(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
                {disasterType === 'earthquake' && (
                  <>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Moment Magnitude</span>
                        <span className="scenario-slider-val">Mw {magnitude}</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={4.5}
                        max={9.0}
                        step={0.1}
                        value={magnitude}
                        onChange={(e) => setMagnitude(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Focal Depth</span>
                        <span className="scenario-slider-val">{depthKm} km</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={2}
                        max={70}
                        step={1}
                        value={depthKm}
                        onChange={(e) => setDepthKm(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
                {disasterType === 'wildfire' && (
                  <>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Air Temperature</span>
                        <span className="scenario-slider-val">{tempC} °C</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={20}
                        max={50}
                        step={1}
                        value={tempC}
                        onChange={(e) => setTempC(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Duration</span>
                        <span className="scenario-slider-val">{durationHours} hours</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={1}
                        max={72}
                        step={1}
                        value={durationHours}
                        onChange={(e) => setDurationHours(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Wind Speed</span>
                        <span className="scenario-slider-val">{windSpeedKmh} km/h</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={5}
                        max={100}
                        step={1}
                        value={windSpeedKmh}
                        onChange={(e) => setWindSpeedKmh(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
                {disasterType === 'landslide' && (
                  <>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Cumulative Rainfall</span>
                        <span className="scenario-slider-val">{rainfallMm} mm</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={50}
                        max={600}
                        step={10}
                        value={rainfallMm}
                        onChange={(e) => setRainfallMm(Number(e.target.value))}
                      />
                    </div>
                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Duration</span>
                        <span className="scenario-slider-val">{durationHours} hours</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={1}
                        max={72}
                        step={1}
                        value={durationHours}
                        onChange={(e) => setDurationHours(Number(e.target.value))}
                      />
                    </div>
                  </>
                )}
              </div>
              <button
                className="btn-run-simulation-primary"
                onClick={() => executeSimulation()}
                disabled={loading}
              >
                {loading ? '⏳ Calculating Simulation...' : '▶ Run Simulation'}
              </button>
            </div>

            {/* Card: Simulation Timeline Scrubber */}
            {result && (
              <div className="floating-timeline-bar sidebar-timeline-card">
                {lastCompletedRun && (
                  <div className="timeline-active-run-hud" title={`Simulation Run UUID: ${result.run_uuid || lastCompletedRun.id}`}>
                    <span className="live-status-dot" />
                    <span className="hud-label">ACTIVE RUN #{lastCompletedRun.id}:</span>
                    <span className="hud-summary">{lastCompletedRun.summary}</span>
                    <span className="hud-time">({lastCompletedRun.time})</span>
                  </div>
                )}
                <div className="timeline-controls-row">
                  <div className="timeline-sidebar-header-row">
                    <div className="timeline-header-label">
                      Simulation Timeline ({totalSimulationHours.toFixed(0)} hours)
                    </div>
                    <div className="timeline-current-time-badge">
                      {formatTimelineHours(currentTime)}
                    </div>
                  </div>

                  <div className="timeline-scrubber-wrapper">
                    <input
                      type="range"
                      className="timeline-slider"
                      min={0}
                      max={Math.max(totalFrames - 1, 0)}
                      value={currentFrame}
                      onChange={(e) => {
                        setCurrentFrame(Number(e.target.value));
                        setIsPlaying(false);
                      }}
                    />
                    <div className="timeline-tick-labels">
                      {Array.from({ length: 9 }).map((_, idx) => {
                        const h = Math.round((idx / 8) * totalSimulationHours);
                        return <span key={idx}>{h}h</span>;
                      })}
                    </div>
                  </div>

                  <div className="timeline-sidebar-actions-row">
                    <button className="timeline-play-toggle" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                      {isPlaying ? '⏸' : '▶'}
                    </button>
                    <div className="timeline-step-btn-group">
                      <button
                        className="timeline-step-btn"
                        onClick={() => setCurrentFrame((prev) => Math.max(0, prev - 1))}
                        title="Previous Timestep"
                      >
                        ‹
                      </button>
                      <button
                        className="timeline-step-btn"
                        onClick={() => setCurrentFrame((prev) => Math.min(totalFrames - 1, prev + 1))}
                        title="Next Timestep"
                      >
                        ›
                      </button>
                    </div>
                    <div className="timeline-speed-controls">
                      {[1, 2, 4].map((s) => (
                        <button
                          key={s}
                          className={`speed-pill ${playSpeed === s ? 'speed-pill--active' : ''}`}
                          onClick={() => setPlaySpeed(s)}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Card 2: Impact Summary (2x2 Grid) */}
            <div className="modern-impact-card">
              <div className="impact-card-title">Impact Summary (Current View)</div>
              <div className="impact-2x2-grid">
                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(2, 132, 199, 0.25)', color: '#38bdf8' }}>
                    {disasterType === 'cyclone' ? '🌀' : disasterType === 'wildfire' ? '🔥' : disasterType === 'earthquake' ? '🏚️' : disasterType === 'landslide' ? '⛰️' : '💧'}
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? `${(impact.flooded_area_km2 ?? impact.affected_area_km2 ?? 0).toFixed(2)} km²` : '—'}
                    </div>
                    <div className="impact-2x2-label">
                      {disasterType === 'flood' ? 'Estimated Flooded Area' : 'Estimated Impact Area'}
                    </div>
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(168, 85, 247, 0.25)', color: '#c084fc' }}>
                    👥
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? (impact.estimated_population_exposed ?? 0).toLocaleString() : '—'}
                    </div>
                    <div className="impact-2x2-label">Population Exposed</div>
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#60a5fa' }}>
                    🏢
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? (impact.buildings_affected ?? 0).toLocaleString() : '—'}
                    </div>
                    <div className="impact-2x2-label">Buildings Affected</div>
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                    🛣️
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && roadStatus ? roadStatus.closed : '—'}
                    </div>
                    <div className="impact-2x2-label">Road Segments Closed</div>
                  </div>
                </div>

                <div className="impact-2x2-tile impact-2x2-tile--full">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(245, 158, 11, 0.25)', color: '#fbbf24' }}>
                    ⚠️
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? impact.critical_facilities_at_risk : '—'}
                    </div>
                    <div className="impact-2x2-label">Critical Facilities at Risk</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: Nearby Facilities */}
            <div className="modern-facilities-card">
              <div className="facilities-card-header">
                <div className="facilities-card-title">Nearby Facilities</div>
                <button className="facilities-view-all-btn" onClick={() => setShowProvenanceDrawer(true)}>
                  View All ↗
                </button>
              </div>
              <div className="facilities-list">
                {result && displayFacilities.length > 0 ? (
                  displayFacilities.map((fac: any, idx: number) => {
                    const visual = getFacilityVisual(fac.type || fac.amenity || fac.name);
                    const distStr = fac.distance_km != null ? `${Number(fac.distance_km).toFixed(1)} km` : '~ 0.8 km';
                    const evacMatch = result?.evacuation_routes?.find(
                      (r) => r.to_facility_name?.toLowerCase() === fac.name?.toLowerCase()
                    );
                    const travelTime = evacMatch
                      ? Math.round(evacMatch.estimated_travel_time_min)
                      : Math.max(3, Math.round((fac.distance_km ?? 0.8) * 12));

                    return (
                      <div className="facility-list-row" key={fac.id || idx}>
                        <div className="facility-list-left">
                          <div
                            className="facility-icon-square"
                            style={{ background: visual.bg, color: visual.color }}
                          >
                            {visual.icon}
                          </div>
                          <span className="facility-list-name" title={fac.name}>
                            {fac.name}
                          </span>
                        </div>
                        <div className="facility-list-right">
                          <span>{distStr}</span>
                          <span className="facility-time-badge">~ {travelTime} min</span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="panel-standby-box">
                    <span className="panel-standby-icon">📍</span>
                    <div className="panel-standby-text">
                      {loading
                        ? 'Analyzing OpenStreetMap infrastructure...'
                        : 'No active simulation. Draw an AOI on the map or click "Run Simulation" to analyze nearby facilities.'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Card 4: AI Insight */}
            <div className="modern-ai-insight-card">
              <div className="ai-insight-title-row">
                <div className="ai-insight-header-left">
                  <span className="ai-insight-symbol">💡</span>
                  <span className="ai-insight-label">AI Insight</span>
                </div>
                <span className="ai-insight-beta-tag">Beta</span>
              </div>
              <div className="ai-insight-content">
                {result ? (
                  aiInsight?.summary || "Simulation complete. No severe hazard anomalies identified in this zone."
                ) : (
                  <span style={{ color: '#6e7681', fontStyle: 'italic' }}>
                    Select an Area of Interest (AOI) or click <strong>Run Simulation</strong> to generate AI-grounded disaster insights.
                  </span>
                )}
              </div>
            </div>
          </aside>
        </main>




      </div>

      {/* ─── Scenario Configuration & Natural Language Modal ──── */}
      {showScenarioModal && (
        <div className="modal-backdrop" onClick={() => setShowScenarioModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Scenario Orchestrator</div>
                <div className="modal-subtitle">Configure physics parameters or use AI natural language</div>
              </div>
              <button className="modal-close-btn" onClick={() => setShowScenarioModal(false)}>✕</button>
            </div>

            {/* Natural Language Prompt Box */}
            <form className="nl-prompt-form" onSubmit={handleNaturalLanguageSubmit}>
              <div className="nl-input-wrapper">
                <span>🤖</span>
                <input
                  type="text"
                  placeholder="e.g. 'Simulate 250 mm rainfall in 18 hours with 2.5m surge'..."
                  value={nlPrompt}
                  onChange={(e) => setNlPrompt(e.target.value)}
                />
                <button type="submit" className="nl-submit-btn" disabled={nlParsing}>
                  {nlParsing ? 'Parsing...' : 'AI Extract & Run'}
                </button>
              </div>
            </form>

            {/* Presets List */}
            <div className="modal-section-title">Authoritative Validation Presets</div>
            <div className="preset-cards-list">
              {presets.map((p) => (
                <div key={p.id} className="preset-card-item" onClick={() => handleApplyPreset(p)}>
                  <div className="preset-card-header">
                    <span className="preset-name">{p.name}</span>
                    <span className="preset-type-tag">{p.disaster_type.toUpperCase()}</span>
                  </div>
                  <div className="preset-desc">{p.description}</div>
                </div>
              ))}
            </div>

            {/* Numerical Parameter Sliders */}
            <div className="modal-section-title">Manual Parameters ({disasterType.toUpperCase()})</div>
            {disasterType === 'flood' && (
              <div className="param-controls-grid">
                <div className="param-field">
                  <label>Rainfall: {rainfallMm} mm</label>
                  <input type="range" min="20" max="1500" step="10" value={rainfallMm} onChange={(e) => setRainfallMm(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label>Duration: {durationHours} hours</label>
                  <input type="range" min="1" max="72" step="1" value={durationHours} onChange={(e) => setDurationHours(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label>Coastal Storm Surge: {seaLevelSurge} m</label>
                  <input type="range" min="0" max="8" step="0.2" value={seaLevelSurge} onChange={(e) => setSeaLevelSurge(Number(e.target.value))} />
                </div>
              </div>
            )}
            {disasterType === 'earthquake' && (
              <div className="param-controls-grid">
                <div className="param-field">
                  <label>Magnitude: {magnitude} Mw</label>
                  <input type="range" min="5.0" max="9.0" step="0.1" value={magnitude} onChange={(e) => setMagnitude(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label>Focal Depth: {depthKm} km</label>
                  <input type="range" min="2" max="100" step="2" value={depthKm} onChange={(e) => setDepthKm(Number(e.target.value))} />
                </div>
              </div>
            )}
            {disasterType === 'cyclone' && (
              <div className="param-controls-grid">
                <div className="param-field">
                  <label>Max Wind Speed: {windSpeedKmh} km/h</label>
                  <input type="range" min="60" max="280" step="5" value={windSpeedKmh} onChange={(e) => setWindSpeedKmh(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label>Central Pressure: {centralPressure} hPa</label>
                  <input type="range" min="890" max="1000" step="5" value={centralPressure} onChange={(e) => setCentralPressure(Number(e.target.value))} />
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowScenarioModal(false)}>Close</button>
              <button className="btn-execute-primary" onClick={() => { setShowScenarioModal(false); executeSimulation(); }}>
                Execute Simulation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Evidence & Data Provenance Drawer ──────────────────── */}
      {showProvenanceDrawer && (
        <div className="drawer-backdrop" onClick={() => setShowProvenanceDrawer(false)}>
          <div className="evidence-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <div className="drawer-title">Data Provenance & Scientific Evidence</div>
                <div className="drawer-subtitle">Inspect underlying authoritative datasets, versions, and physical equations</div>
              </div>
              <button className="modal-close-btn" onClick={() => setShowProvenanceDrawer(false)}>✕</button>
            </div>

            <div className="drawer-body">
              <div className="drawer-section-heading">Current Simulation Engine</div>
              {provenanceData && (
                <div className="engine-spec-card">
                  <div className="engine-name">{provenanceData.disaster_model.model_name} ({provenanceData.disaster_model.version})</div>
                  <div className="engine-eq"><strong>Governing Equations:</strong> {provenanceData.disaster_model.governing_equations}</div>
                  <div className="engine-assumptions">
                    <strong>Model Assumptions:</strong>
                    <ul>
                      {provenanceData.disaster_model.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="engine-uncertainty"><strong>Uncertainty Profile:</strong> {provenanceData.disaster_model.uncertainty}</div>
                </div>
              )}

              <div className="drawer-section-heading">Authoritative Geospatial Datasets</div>
              <div className="evidence-sources-table-wrapper">
                <table className="evidence-table">
                  <thead>
                    <tr>
                      <th>Dataset</th>
                      <th>Provider / Source</th>
                      <th>Resolution</th>
                      <th>Layers</th>
                      <th>Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(provenanceData?.data_sources || []).map((ds) => (
                      <tr key={ds.id}>
                        <td><strong>{ds.name}</strong><br/><small>{ds.license}</small></td>
                        <td>{ds.provider}<br/><a href={ds.source_url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>Source Link &rarr;</a></td>
                        <td>{ds.spatial_resolution}</td>
                        <td>{ds.layer_types.join(', ')}</td>
                        <td><span className="badge-confidence">{ds.confidence}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="drawer-disclaimer-notice">
                {provenanceData?.disclaimer}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
