import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  getAiKeyStatus,
  saveAiKey,
} from './services/api';
import MapView from './components/MapView';
import ErrorBoundary from './components/ErrorBoundary';
import {
  IconLocationPin,
  IconSearch,
  IconPolice,
  IconHospital,
  IconShelter,
  IconFireStation,
  IconSchool,
  IconMedicalCross,
  IconPlay,
  IconPause,
  IconFlood,
  IconCyclone,
  IconHeatwave,
  IconEarthquake,
  IconLandslide,
  IconPopulation,
  IconBuilding,
  IconRoad,
  IconAlertTriangle,
  IconInsight,
} from './components/Icons';

// ─── Run History persistence (localStorage, quota-safe) ─────────────
interface RunHistoryEntry {
  id: string;
  summary: string;
  disaster: string;
  time: string;
  result: SimulationResult;
}

const HISTORY_STORAGE_KEY = 'disasterlens-run-history';
const HISTORY_MAX_ENTRIES = 10;
// Must match backend BoundingBox area cap (main.py). Checked client-side for instant feedback.
const MAX_AOI_AREA_DEG2 = 4.0;

function loadRunHistory(): RunHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as RunHistoryEntry[]).filter(
      (e) =>
        e &&
        typeof e.id === 'string' &&
        typeof e.summary === 'string' &&
        typeof e.disaster === 'string' &&
        typeof e.time === 'string' &&
        Array.isArray((e.result as unknown as { simulation?: { frames?: unknown } })?.simulation?.frames)
    ).slice(0, HISTORY_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function saveRunHistory(entries: RunHistoryEntry[]): void {
  // localStorage quota (~5MB) may not fit all runs — keep the newest entries that fit.
  for (const n of [entries.length, 5, 3, 1]) {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, Math.max(n, 0))));
      return;
    } catch {
      /* quota exceeded — retry with fewer entries */
    }
  }
}

function getCompassLabel(deg: number): string {
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

function App() {
  // State (Initialized clean: no auto-selected city or auto-scan on start)
  const [disasterType, setDisasterType] = useState<DisasterType>('flood');
  const [locationName, setLocationName] = useState('');
  const [bbox, setBbox] = useState<BoundingBox | null>(null);

  // Safeguard: fallback to flood if cyclone is selected
  useEffect(() => {
    if ((disasterType as string) === 'cyclone') {
      setDisasterType('flood');
    }
  }, [disasterType]);

  // Scenario Parameters
  const [rainfallMm, setRainfallMm] = useState(300);
  const [durationHours, setDurationHours] = useState(24);
  const [seaLevelSurge, setSeaLevelSurge] = useState(2.5);
  const [magnitude, setMagnitude] = useState(6.8);
  const [depthKm, setDepthKm] = useState(10.0);
  const [windSpeedKmh, setWindSpeedKmh] = useState(165);
  const [centralPressure, setCentralPressure] = useState(945);
  const [cycloneDirection, setCycloneDirection] = useState(315); // degrees, 315 = NW
  const [cycloneRadiusKm, setCycloneRadiusKm] = useState(35); // Eye wall radius Rmax in km
  const [stormRadiusKm, setStormRadiusKm] = useState(180); // Outer gale radius in km
  const [cycloneSpeedKmh, setCycloneSpeedKmh] = useState(22); // Forward translation speed km/h
  const [tempC, setTempC] = useState(36);
  const [humidityPct, setHumidityPct] = useState(20);

  // Live Cyclone Meteorological Classification & Inundation Surge Preview
  const cycloneCategoryInfo = useMemo(() => {
    if (windSpeedKmh >= 252) {
      return { cat: 'Category 5', imd: 'Super Cyclonic Storm (SuCS)', color: '#c084fc', border: '#a855f7', badge: 'Catastrophic' };
    }
    if (windSpeedKmh >= 209) {
      return { cat: 'Category 4', imd: 'Extremely Severe Cyclonic Storm (ESCS)', color: '#f43f5e', border: '#e11d48', badge: 'Severe Devastation' };
    }
    if (windSpeedKmh >= 178) {
      return { cat: 'Category 3', imd: 'Very Severe Cyclonic Storm (VSCS)', color: '#fb923c', border: '#ea580c', badge: 'Major Hurricane' };
    }
    if (windSpeedKmh >= 154) {
      return { cat: 'Category 2', imd: 'Severe Cyclonic Storm (SCS)', color: '#facc15', border: '#ca8a04', badge: 'Moderate Cyclone' };
    }
    if (windSpeedKmh >= 119) {
      return { cat: 'Category 1', imd: 'Cyclonic Storm (CS)', color: '#38bdf8', border: '#0284c7', badge: 'Minimal Cyclone' };
    }
    return { cat: 'Tropical Storm', imd: 'Deep Depression (DD)', color: '#34d399', border: '#059669', badge: 'Gale Wind System' };
  }, [windSpeedKmh]);

  const cycloneEstimatedSurgeM = useMemo(() => {
    const dp = Math.max(5, 1013 - centralPressure);
    const ibSurge = (dp * 100) / (1025 * 9.81);
    const vMs = windSpeedKmh / 3.6;
    const windSurge = 0.00065 * Math.pow(vMs, 1.8);
    return Math.min(8.5, ibSurge + windSurge);
  }, [centralPressure, windSpeedKmh]);

  const autoSyncPressureFromWind = useCallback((wind: number) => {
    // Atkinson-Holliday & Kraft cyclostrophic empirical relationship
    const vMs = wind / 3.6;
    const dp = Math.pow(vMs / 6.25, 2.0);
    const estP = Math.round(Math.max(880, Math.min(1005, 1013 - dp)));
    setCentralPressure(estP);
  }, []);

  // Wildfire Comprehensive Parameters
  const [wildfireWindSpeed, setWildfireWindSpeed] = useState(25);
  const [wildfireWindDir, setWildfireWindDir] = useState(135); // NW to SE (135 deg)
  const [wildfireTempC, setWildfireTempC] = useState(38);
  const [wildfireHumidityPct, setWildfireHumidityPct] = useState(25);
  const [ignitionLat, setIgnitionLat] = useState<number | null>(17.385);
  const [ignitionLon, setIgnitionLon] = useState<number | null>(78.486);
  const [initialFireRadiusM, setInitialFireRadiusM] = useState(10);
  const [fuelType, setFuelType] = useState('auto');
  const [fuelMoisturePct, setFuelMoisturePct] = useState<number | 'auto'>('auto');
  const [slopeDeg, setSlopeDeg] = useState<number | 'auto'>('auto');
  const [aspectDir, setAspectDir] = useState('auto');
  const [recentRainfallMm, setRecentRainfallMm] = useState(2);
  const [showManualFuelOverrides, setShowManualFuelOverrides] = useState(false);
  const [openWildfireSection, setOpenWildfireSection] = useState<'ignition' | 'weather' | 'fuel' | null>('ignition');
  const [isPickingIgnition, setIsPickingIgnition] = useState<boolean>(false);

  // Simulation State
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'online' | 'offline' | 'checking'>('checking');
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>(loadRunHistory);

  // Timeline State
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<number>(1);
  const [timelineUnitMode, setTimelineUnitMode] = useState<'auto' | 'minutes' | 'hours'>('auto');
  // Wildfire duration input unit: 'minutes' = slider in minutes (0-180min), 'hours' = slider in hours (0.25-24h)
  const [wildfireDurationUnit, setWildfireDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const playIntervalRef = useRef<number | null>(null);

  // Map & Visual State
  const [mapMode, setMapMode] = useState<'satellite' | 'map'>('satellite');
  const [selectedRoad, setSelectedRoad] = useState<RoadFeature | null>(null);
  const [focusedFacility, setFocusedFacility] = useState<{ fac: any; nonce: number } | null>(null);
  const [showAllFacilities, setShowAllFacilities] = useState(false);
  const [warningsDismissedForRun, setWarningsDismissedForRun] = useState<string | null>(null);
  const [settingsPageOpen, setSettingsPageOpen] = useState(false);
  const [buildingDensity, setBuildingDensity] = useState<'medium' | 'maximum'>(() => {
    try {
      return localStorage.getItem('disasterlens-building-density') === 'maximum' ? 'maximum' : 'medium';
    } catch {
      return 'medium';
    }
  });
  const [showEvacuationRoutes, setShowEvacuationRoutes] = useState(false);

  // Drawers & Modals
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [showProvenanceDrawer, setShowProvenanceDrawer] = useState(false);
  const [provenanceData, setProvenanceData] = useState<ProvenanceResponse | null>(null);
  const [nlPrompt, setNlPrompt] = useState('');
  const [nlParsing, setNlParsing] = useState(false);
  const [presets, setPresets] = useState<ScenarioPreset[]>([]);

  // Mode switcher for right sidebar: 'manual' (sliders) vs 'gen_ai' (Gemini Flash-Lite chat prompt)
  const [sidebarInputMode, setSidebarInputMode] = useState<'manual' | 'gen_ai'>('manual');
  const [aiChatPrompt, setAiChatPrompt] = useState('');
  const [aiChatLoading, setAiChatLoading] = useState(false);
  const [aiAutoRun, setAiAutoRun] = useState(true);
  const [aiChatHistory, setAiChatHistory] = useState<Array<{
    role: 'user' | 'assistant';
    text: string;
    parsed?: any;
    timestamp: string;
  }>>([
    {
      role: 'assistant',
      text: '🤖 Welcome to Gen AI Mode powered by Gemini 3.5 Flash-Lite. Enter any disaster scenario in natural language to extract physical parameters and run the simulation.',
      timestamp: 'Ready',
    },
  ]);

  // AI Key Configuration State (Google Gemini 3.5 Flash-Lite)
  const [aiKeyStatus, setAiKeyStatus] = useState<{ configured: boolean; masked_key?: string; model?: string }>({ configured: false });
  const [inputAiKey, setInputAiKey] = useState('');
  const [showAiKeyText, setShowAiKeyText] = useState(false);
  const [savingAiKey, setSavingAiKey] = useState(false);
  const [aiKeySaveMsg, setAiKeySaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSaveAiKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanKey = inputAiKey.trim();
    if (!cleanKey) {
      setAiKeySaveMsg({ type: 'error', text: 'Please enter a valid Gemini API key.' });
      return;
    }
    setSavingAiKey(true);
    setAiKeySaveMsg(null);
    try {
      const res = await saveAiKey(cleanKey);
      setAiKeyStatus({ configured: res.configured, masked_key: res.masked_key, model: 'gemini-3.5-flash-lite' });
      setInputAiKey('');
      setAiKeySaveMsg({ type: 'success', text: 'Gemini API key saved & persisted to backend/.env successfully!' });
      setTimeout(() => setAiKeySaveMsg(null), 6000);
    } catch (err: any) {
      setAiKeySaveMsg({ type: 'error', text: err.message || 'Failed to save API key' });
    } finally {
      setSavingAiKey(false);
    }
  };

  // Draggable panel layout states
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('disasterlens-right-panel-width');
      return saved ? Math.max(280, Math.min(800, Number(saved))) : 360;
    } catch {
      return 360;
    }
  });
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('disasterlens-left-sidebar-width');
      return saved ? Math.max(180, Math.min(420, Number(saved))) : 220;
    } catch {
      return 220;
    }
  });
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingLeft, setIsResizingLeft] = useState(false);

  // Right Panel Resize Drag Handler
  const startRightResize = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsResizingRight(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const newWidth = Math.max(280, Math.min(window.innerWidth * 0.58, window.innerWidth - clientX));
      setRightPanelWidth(Math.round(newWidth));
    };

    const onEnd = () => {
      setIsResizingRight(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      try {
        setRightPanelWidth((w) => {
          localStorage.setItem('disasterlens-right-panel-width', String(w));
          return w;
        });
      } catch {}
      window.dispatchEvent(new Event('resize'));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
  }, []);

  // Left Sidebar Resize Drag Handler
  const startLeftResize = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsResizingLeft(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const newWidth = Math.max(180, Math.min(window.innerWidth * 0.35, clientX));
      setLeftSidebarWidth(Math.round(newWidth));
    };

    const onEnd = () => {
      setIsResizingLeft(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      try {
        setLeftSidebarWidth((w) => {
          localStorage.setItem('disasterlens-left-sidebar-width', String(w));
          return w;
        });
      } catch {}
      window.dispatchEvent(new Event('resize'));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
  }, []);

  // Initial Load: Health Check, Presets
  useEffect(() => {
    healthCheck()
      .then((h) => {
        setBackendStatus('online');
      })
      .catch(() => setBackendStatus('offline'));

    getPresets().then((p) => setPresets(p)).catch(() => {});
    getProvenance('flood').then((prov) => setProvenanceData(prov)).catch(() => {});
    getAiKeyStatus().then(setAiKeyStatus).catch(() => {});
  }, []);

  // Update Provenance when disaster changes
  useEffect(() => {
    getProvenance(disasterType).then((prov) => setProvenanceData(prov)).catch(() => {});
  }, [disasterType]);

  // Persist run history across refreshes
  useEffect(() => {
    saveRunHistory(runHistory);
  }, [runHistory]);

  // Persist building density preference
  useEffect(() => {
    try {
      localStorage.setItem('disasterlens-building-density', buildingDensity);
    } catch {}
  }, [buildingDensity]);

  // Timeline playback loop
  useEffect(() => {
    if (isPlaying && result) {
      const totalFrames = result.simulation.frames.length;
      // Target ~18s total playback at 1x speed regardless of frame count (min 300ms/frame, max 900ms/frame)
      const baseInterval = Math.min(900, Math.max(300, Math.round(18000 / Math.max(1, totalFrames))));
      playIntervalRef.current = window.setInterval(() => {
        setCurrentFrame((prev) => {
          if (prev >= totalFrames - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, baseInterval / playSpeed);
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
    const targetArea = (targetBbox.north - targetBbox.south) * (targetBbox.east - targetBbox.west);
    if (targetArea > MAX_AOI_AREA_DEG2) {
      setError(`Selected area is ${targetArea.toFixed(2)} deg² — over the ${MAX_AOI_AREA_DEG2} deg² limit. Zoom in and draw a smaller box.`);
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
        wind_speed_kmh: targetDisaster === 'wildfire' ? (overrides?.wind_speed_kmh ?? wildfireWindSpeed) : (overrides?.wind_speed_kmh ?? windSpeedKmh),
        max_wind_kmh: overrides?.max_wind_kmh ?? overrides?.wind_speed_kmh ?? windSpeedKmh,
        wind_direction_deg: targetDisaster === 'wildfire' ? (overrides?.wind_direction_deg ?? wildfireWindDir) : (overrides?.wind_direction_deg ?? 45.0),
        central_pressure_hpa: overrides?.central_pressure_hpa ?? centralPressure,
        cyclone_direction_deg: overrides?.cyclone_direction_deg ?? cycloneDirection,
        cyclone_radius_km: overrides?.cyclone_radius_km ?? cycloneRadiusKm,
        storm_radius_km: overrides?.storm_radius_km ?? stormRadiusKm,
        forward_speed_kmh: overrides?.forward_speed_kmh ?? cycloneSpeedKmh,
        temperature_c: targetDisaster === 'wildfire' ? (overrides?.temperature_c ?? wildfireTempC) : (overrides?.temperature_c ?? tempC),
        relative_humidity_pct: targetDisaster === 'wildfire' ? (overrides?.relative_humidity_pct ?? wildfireHumidityPct) : (overrides?.relative_humidity_pct ?? humidityPct),
        ignition_lat: overrides?.ignition_lat ?? (ignitionLat ?? (targetBbox ? (targetBbox.north + targetBbox.south) / 2 : undefined)),
        ignition_lon: overrides?.ignition_lon ?? (ignitionLon ?? (targetBbox ? (targetBbox.west + targetBbox.east) / 2 : undefined)),
        initial_fire_radius_m: overrides?.initial_fire_radius_m ?? initialFireRadiusM,
        fuel_type: overrides?.fuel_type ?? (fuelType !== 'auto' ? fuelType : 'auto'),
        fuel_moisture_pct: (overrides?.fuel_moisture_pct ?? fuelMoisturePct) !== 'auto' ? (overrides?.fuel_moisture_pct ?? fuelMoisturePct) : undefined,
        slope_deg: (overrides?.slope_deg ?? slopeDeg) !== 'auto' ? (overrides?.slope_deg ?? slopeDeg) : undefined,
        aspect_direction: (overrides?.aspect_direction ?? aspectDir) !== 'auto' ? (overrides?.aspect_direction ?? aspectDir) : undefined,
        recent_rainfall_mm: overrides?.recent_rainfall_mm ?? recentRainfallMm,
        cumulative_rainfall_mm: overrides?.cumulative_rainfall_mm ?? overrides?.rainfall_mm ?? rainfallMm,
      });

      setResult(simResult);
      setCurrentFrame(0);
      setIsPlaying(false);

      const meta = (simResult as any)?.metadata || (simResult as any)?.simulation?.metadata;
      if (meta?.ignition_lat !== undefined && meta?.ignition_lon !== undefined) {
        setIgnitionLat(Number(meta.ignition_lat));
        setIgnitionLon(Number(meta.ignition_lon));
      }

      setRunHistory((prev) => [
        {
          id: simResult.run_uuid ? simResult.run_uuid.slice(0, 8) : `run-${Date.now()}`,
          summary: targetDisaster === 'flood'
            ? `${overrides?.rainfall_mm ?? rainfallMm}mm Rain, +${overrides?.sea_level_surge_m ?? seaLevelSurge}m Surge (${overrides?.duration_hours ?? durationHours}h)`
            : targetDisaster === 'earthquake'
            ? `Mw ${overrides?.magnitude ?? magnitude} (${overrides?.depth_km ?? depthKm}km Depth)`
            : targetDisaster === 'cyclone'
            ? `${overrides?.wind_speed_kmh ?? windSpeedKmh} km/h, ${getCompassLabel(overrides?.cyclone_direction_deg ?? cycloneDirection)}, R=${overrides?.cyclone_radius_km ?? cycloneRadiusKm}km`
            : targetDisaster === 'wildfire'
            ? `${overrides?.temperature_c ?? wildfireTempC}°C, ${overrides?.wind_speed_kmh ?? wildfireWindSpeed}km/h Wind, ${fuelType === 'auto' ? 'Auto DEM Fuel' : fuelType}`
            : `${overrides?.rainfall_mm ?? rainfallMm}mm Rain`,
          disaster: targetDisaster,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          result: simResult,
        },
        ...prev,
      ].slice(0, HISTORY_MAX_ENTRIES));

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

  const disasterIcon = (d: string, size = 14) =>
    d === 'flood' ? <IconFlood size={size} /> : d === 'cyclone' ? <IconCyclone size={size} /> : d === 'earthquake' ? <IconEarthquake size={size} /> : d === 'wildfire' ? <IconHeatwave size={size} /> : <IconLandslide size={size} />;

  // Restore a previous run from history (map, timeline, impact + provenance all follow `result`)
  const handleSelectHistoryRun = (entry: { disaster: string; result: SimulationResult }) => {
    setResult(entry.result);
    setDisasterType(entry.disaster as DisasterType);
    setCurrentFrame(0);
    setIsPlaying(false);
    setSelectedRoad(null);
    setShowEvacuationRoutes(false);
    setError(null);
    if (entry.result.provenance) {
      setProvenanceData(entry.result.provenance);
    }
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

    const pCenterLat = Number(((p.bbox.south + p.bbox.north) / 2).toFixed(4));
    const pCenterLon = Number(((p.bbox.west + p.bbox.east) / 2).toFixed(4));
    const pIgnLat = p.parameters.ignition_lat ?? pCenterLat;
    const pIgnLon = p.parameters.ignition_lon ?? pCenterLon;
    setIgnitionLat(pIgnLat);
    setIgnitionLon(pIgnLon);

    setShowScenarioModal(false);
    executeSimulation({
      bbox: p.bbox,
      disaster_type: p.disaster_type,
      locationName: p.location_name,
      ...p.parameters,
      ignition_lat: pIgnLat,
      ignition_lon: pIgnLon,
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
      setError('Could not parse scenario: ' + err.message);
    } finally {
      setNlParsing(false);
    }
  };

  const handleGenAISubmit = async (promptText?: string) => {
    const text = (promptText !== undefined ? promptText : aiChatPrompt).trim();
    if (!text || aiChatLoading) return;

    setAiChatLoading(true);
    setError(null);

    const userMsgTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setAiChatHistory((prev) => [
      ...prev,
      { role: 'user', text, timestamp: userMsgTime },
    ]);
    setAiChatPrompt('');

    try {
      const parsed = await parseNaturalLanguageScenario(text, disasterType, 'gemini-3.5-flash-lite');

      // Synchronize extracted parameters into App state so manual sliders also update!
      if (parsed.disaster_type) setDisasterType(parsed.disaster_type);
      if (parsed.parameters) {
        const p = parsed.parameters;
        if (p.rainfall_mm !== undefined) setRainfallMm(p.rainfall_mm);
        if (p.cumulative_rainfall_mm !== undefined) setRainfallMm(p.cumulative_rainfall_mm);
        if (p.duration_hours !== undefined) setDurationHours(p.duration_hours);
        if (p.sea_level_surge_m !== undefined) setSeaLevelSurge(p.sea_level_surge_m);
        if (p.magnitude !== undefined) setMagnitude(p.magnitude);
        if (p.wind_speed_kmh !== undefined) {
          setWindSpeedKmh(p.wind_speed_kmh);
          setWildfireWindSpeed(p.wind_speed_kmh);
        }
        if (p.max_wind_kmh !== undefined) setWindSpeedKmh(p.max_wind_kmh);
        if (p.wind_direction_deg !== undefined) {
          setCycloneDirection(p.wind_direction_deg);
          setWildfireWindDir(p.wind_direction_deg);
        }
        if (p.temperature_c !== undefined) setWildfireTempC(p.temperature_c);
        if (p.relative_humidity_pct !== undefined) setWildfireHumidityPct(p.relative_humidity_pct);
      }

      const aiReply = parsed.explanation || `Assigned ${parsed.disaster_type?.toUpperCase()} parameters. Ready to simulate.`;
      const aiMsgTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      setAiChatHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: aiReply,
          parsed,
          timestamp: aiMsgTime,
        },
      ]);

      // If auto-run is enabled, immediately trigger the simulation
      if (aiAutoRun) {
        executeSimulation({
          disaster_type: parsed.disaster_type || disasterType,
          ...parsed.parameters,
        });
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to parse scenario with Gemini';
      setError('Gen AI error: ' + errMsg);
      setAiChatHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `⚠️ Error: ${errMsg}. Please try another prompt.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setAiChatLoading(false);
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
        const cLat = Number(((geo.bbox.south + geo.bbox.north) / 2).toFixed(4));
        const cLon = Number(((geo.bbox.west + geo.bbox.east) / 2).toFixed(4));
        if (!ignitionLat || !ignitionLon || ignitionLat < geo.bbox.south || ignitionLat > geo.bbox.north || ignitionLon < geo.bbox.west || ignitionLon > geo.bbox.east) {
          setIgnitionLat(cLat);
          setIgnitionLon(cLon);
        }
      } else {
        setError(`Location "${locationName}" not found on OpenStreetMap. Try a city, region, or draw an area on the map.`);
      }
    } catch (err: any) {
      setError('Geocoding error: ' + err.message);
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
    const drawnArea = (newBbox.north - newBbox.south) * (newBbox.east - newBbox.west);
    if (drawnArea > MAX_AOI_AREA_DEG2) {
      setError(`Selected area is ${drawnArea.toFixed(2)} deg² — over the ${MAX_AOI_AREA_DEG2} deg² limit. Please draw a smaller box.`);
    } else {
      setError(null);
    }
    setResult(null);
    setSelectedRoad(null);

    const cLat = Number(centerLat.toFixed(4));
    const cLon = Number(centerLon.toFixed(4));
    if (!ignitionLat || !ignitionLon || ignitionLat < newBbox.south || ignitionLat > newBbox.north || ignitionLon < newBbox.west || ignitionLon > newBbox.east) {
      setIgnitionLat(cLat);
      setIgnitionLon(cLon);
    }

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
  const rawCurrentTime = result?.simulation.timesteps?.[currentFrame] ?? 0;
  const totalSimulationHours = result?.simulation.total_time_hours || durationHours;
  const rawTimeUnit = result?.simulation.time_unit || (disasterType === 'earthquake' ? 'seconds' : disasterType === 'landslide' ? 'minutes' : 'hours');
  const rawTotalTime = result?.simulation.total_time ?? (
    disasterType === 'earthquake' ? 90 : disasterType === 'landslide' ? 15 : totalSimulationHours
  );

  const effectiveUnit = useMemo<'seconds' | 'minutes' | 'hours'>(() => {
    if (timelineUnitMode === 'minutes') return 'minutes';
    if (timelineUnitMode === 'hours') return 'hours';
    // 'auto' mode
    if (rawTimeUnit === 'seconds' || rawTimeUnit === 's') return 'seconds';
    if (rawTimeUnit === 'minutes' || rawTimeUnit === 'min') return 'minutes';
    if (disasterType === 'wildfire' && durationHours <= 2) return 'minutes';
    return 'hours';
  }, [timelineUnitMode, rawTimeUnit, disasterType, durationHours]);

  const convertTimeToEffective = (val: number) => {
    let valInMinutes = val;
    if (rawTimeUnit === 'seconds' || rawTimeUnit === 's') {
      valInMinutes = val / 60;
    } else if (rawTimeUnit === 'hours' || rawTimeUnit === 'h') {
      valInMinutes = val * 60;
    }

    if (effectiveUnit === 'seconds') return valInMinutes * 60;
    if (effectiveUnit === 'hours') return valInMinutes / 60;
    return valInMinutes;
  };

  const roadStatus = impact?.road_status;
  const totalRoads = roadStatus?.total || 1;
  const openPct = Math.round(((roadStatus?.open || 0) / totalRoads) * 100);
  const restrictedPct = Math.round(((roadStatus?.restricted || 0) / totalRoads) * 100);
  const closedPct = Math.round(((roadStatus?.closed || 0) / totalRoads) * 100);

  const formatSimulationTime = (rawVal: number) => {
    const converted = convertTimeToEffective(rawVal);
    if (effectiveUnit === 'seconds') {
      return `T+${Math.round(converted)}s`;
    }
    if (effectiveUnit === 'minutes') {
      const mins = Math.round(converted * 10) / 10;
      return `T+${mins % 1 === 0 ? mins.toFixed(0) : mins.toFixed(1)}m`;
    }
    const totalMinutes = Math.round(converted * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hrs === 0) return `T+${mins}m`;
    return mins > 0 ? `T+${hrs}h ${mins}m` : `T+${hrs}h`;
  };

  const formatTickLabel = (rawVal: number) => {
    const converted = convertTimeToEffective(rawVal);
    if (effectiveUnit === 'seconds') {
      return `${Math.round(converted)}s`;
    }
    if (effectiveUnit === 'minutes') {
      const mins = Math.round(converted * 10) / 10;
      return `${mins % 1 === 0 ? mins.toFixed(0) : mins.toFixed(1)}m`;
    }
    const totalMinutes = Math.round(converted * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hrs === 0) return `${mins}m`;
    if (mins === 0) return `${hrs}h`;
    return `${hrs}h${mins}m`;
  };

  const dynamicTicks = useMemo(() => {
    if (!result?.simulation.timesteps || result.simulation.timesteps.length === 0) {
      return ['Start', 'End'];
    }
    const rawLabels = result.simulation.timesteps.map((t) => formatTickLabel(t));
    if (rawLabels.length <= 6) return rawLabels;
    const count = 5;
    return Array.from({ length: count }, (_, i) => {
      const idx = Math.round((i * (rawLabels.length - 1)) / (count - 1));
      return rawLabels[idx];
    });
  }, [result, effectiveUnit, rawTimeUnit]);

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

  const displayFacilities = showAllFacilities ? realFacilities : realFacilities.slice(0, 4);

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
    <div
      className={`app-root-layout ${isResizingRight || isResizingLeft ? 'layout-resizing-active' : ''}`}
      style={{
        '--right-panel-width': `${rightPanelWidth}px`,
        '--left-sidebar-width': `${leftSidebarWidth}px`,
      } as React.CSSProperties}
    >
      {/* Dismissible error banner (existing error state, previously never rendered) */}
      {error && (
        <div className="app-error-banner" role="alert">
          <span className="app-error-banner__text">{error}</span>
          <button
            className="app-error-banner__close"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* ─── Left Sidebar ────────────────────────────────────────── */}
      <aside
        className="app-left-sidebar"
        style={{
          width: `${leftSidebarWidth}px`,
          minWidth: `${leftSidebarWidth}px`,
          maxWidth: `${leftSidebarWidth}px`,
        }}
      >
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
            <button className="sidebar-nav-btn" onClick={() => setSettingsPageOpen(true)}>
              <span className="sidebar-nav-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </span>
              <span>Settings</span>
            </button>
          </nav>
        </div>

          {/* ─── Run History (every Run Simulation is stored here) ─── */}
          <div className="sidebar-history-section">
            <div className="sidebar-history-header">
              <span className="sidebar-history-title">Run History</span>
              {runHistory.length > 0 && (
                <button
                  className="sidebar-history-clear"
                  onClick={() => setRunHistory([])}
                  title="Clear run history"
                  aria-label="Clear run history"
                >
                  Clear
                </button>
              )}
            </div>
            {runHistory.length === 0 ? (
              <div className="sidebar-history-empty">
                No simulations yet.<br />Each run will be stored here.
              </div>
            ) : (
              <div className="sidebar-history-list">
                {runHistory.map((run, idx) => {
                  const isActive = result?.run_uuid != null && result.run_uuid === run.result.run_uuid;
                  return (
                    <button
                      key={`${run.id}-${idx}`}
                      className={`sidebar-history-item${isActive ? ' sidebar-history-item--active' : ''}`}
                      onClick={() => handleSelectHistoryRun(run)}
                      title={run.summary}
                    >
                      <span className="sidebar-history-emoji">{disasterIcon(run.disaster, 16)}</span>
                      <span className="sidebar-history-meta">
                        <span className="sidebar-history-summary">{run.summary}</span>
                        <span className="sidebar-history-sub">
                          #{runHistory.length - idx} • {run.disaster} • {run.time}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
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

      {/* Draggable Divider on Left Sidebar Edge */}
      <div
        className={`panel-resizer panel-resizer--left ${isResizingLeft ? 'panel-resizer--active' : ''}`}
        onMouseDown={startLeftResize}
        onTouchStart={startLeftResize}
        onDoubleClick={() => {
          setLeftSidebarWidth(220);
          try { localStorage.setItem('disasterlens-left-sidebar-width', '220'); } catch {}
          window.dispatchEvent(new Event('resize'));
        }}
        title="Drag to resize left sidebar • Double-click to reset (220px)"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left sidebar"
      >
        <div className="panel-resizer-line" />
      </div>

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
            <span
              className={`backend-status-dot backend-status-dot--${backendStatus}`}
              title={backendStatus === 'online' ? 'Backend online' : backendStatus === 'offline' ? 'Backend offline' : 'Checking backend status'}
            />
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
            <ErrorBoundary>
              <MapView
                mapMode={mapMode}
                setMapMode={setMapMode}
                onBboxSelect={handleBboxSelection}
                result={result}
                currentFrame={currentFrame}
                setCurrentFrame={setCurrentFrame}
                bbox={bbox}
                showEvacuationRoutes={showEvacuationRoutes}
                selectedRoad={selectedRoad}
                setSelectedRoad={setSelectedRoad}
                disasterType={disasterType}
                setDisasterType={handleDisasterSelect}
                focusedFacility={focusedFacility}
                buildingDensity={buildingDensity}
                isPlaying={isPlaying}
                setIsPlaying={setIsPlaying}
                playSpeed={playSpeed}
                setPlaySpeed={setPlaySpeed}
                ignitionLat={ignitionLat}
                ignitionLon={ignitionLon}
                initialFireRadiusM={initialFireRadiusM}
                wildfireWindDir={wildfireWindDir}
                wildfireWindSpeed={wildfireWindSpeed}
                onIgnitionSelect={(lat, lon) => {
                  setIgnitionLat(Number(lat.toFixed(4)));
                  setIgnitionLon(Number(lon.toFixed(4)));
                }}
                isPickingIgnition={isPickingIgnition}
                setIsPickingIgnition={setIsPickingIgnition}
              />
            </ErrorBoundary>

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
              <button className="map-timeline-play-btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}>
                {isPlaying ? <IconPause size={13} color="#ffffff" /> : <IconPlay size={13} color="#ffffff" />}
              </button>

              <div className="map-timeline-scrubber-box">
                <div className="map-timeline-label">
                  Simulation Timeline ({
                    effectiveUnit === 'seconds'
                      ? `${Math.round(convertTimeToEffective(rawTotalTime))} seconds`
                      : effectiveUnit === 'minutes'
                      ? `${Math.round(convertTimeToEffective(rawTotalTime))} minutes`
                      : rawTotalTime < 1
                      ? `${Math.round(rawTotalTime * 60)} minutes`
                      : rawTotalTime % 1 !== 0
                      ? `${Math.floor(rawTotalTime)}h ${Math.round((rawTotalTime % 1) * 60)}m`
                      : `${rawTotalTime.toFixed(0)} hours`
                  })
                </div>
                <input
                  type="range"
                  className="map-timeline-slider"
                  id="map-timeline-slider"
                  aria-label="Simulation timeline"
                  min={0}
                  max={Math.max(totalFrames - 1, 0)}
                  value={currentFrame}
                  onChange={(e) => {
                    setCurrentFrame(Number(e.target.value));
                    setIsPlaying(false);
                  }}
                />
                <div className="map-timeline-ticks">
                  {dynamicTicks.map((lbl, idx) => (
                    <span key={idx}>{lbl}</span>
                  ))}
                </div>
              </div>

              <div className="map-timeline-time-badge">
                {formatSimulationTime(rawCurrentTime)}
              </div>

              {/* Time Unit Selector: min / hr */}
              <div className="map-timeline-unit-selector" title="Toggle timeline display unit">
                {(['auto', 'minutes', 'hours'] as const).map((u) => (
                  <button
                    key={u}
                    className={`map-timeline-unit-btn${timelineUnitMode === u ? ' map-timeline-unit-btn--active' : ''}`}
                    onClick={() => setTimelineUnitMode(u)}
                    aria-pressed={timelineUnitMode === u}
                    title={u === 'auto' ? 'Auto-detect time unit' : u === 'minutes' ? 'Show minutes' : 'Show hours'}
                  >
                    {u === 'auto' ? 'Auto' : u === 'minutes' ? 'min' : 'hr'}
                  </button>
                ))}
              </div>

              <div
                className="map-timeline-speed-pill"
                onClick={() => setPlaySpeed(playSpeed === 0.5 ? 1 : playSpeed === 1 ? 2 : playSpeed === 2 ? 4 : 0.5)}
                role="button"
                aria-label="Cycle playback speed"
                title="Cycle playback speed (0.5x slow-mo, 1x normal, 2x fast, 4x rapid)"
              >
                <span>{playSpeed}x</span>
                <span className="speed-chevron">⌄</span>
              </div>
            </div>
          </div>

          {/* Draggable Divider on Right Panel Edge */}
          <div
            className={`panel-resizer panel-resizer--right ${isResizingRight ? 'panel-resizer--active' : ''}`}
            onMouseDown={startRightResize}
            onTouchStart={startRightResize}
            onDoubleClick={() => {
              setRightPanelWidth(360);
              try { localStorage.setItem('disasterlens-right-panel-width', '360'); } catch {}
              window.dispatchEvent(new Event('resize'));
            }}
            title="Drag to resize right panel • Double-click to reset (360px)"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right panel"
          >
            <div className="panel-resizer-line" />
          </div>

          {/* Right Control & Analytics Panel */}
          <ErrorBoundary>
          <aside
            className="workspace-right-panel"
            style={{
              width: `${rightPanelWidth}px`,
              minWidth: `${rightPanelWidth}px`,
              maxWidth: `${rightPanelWidth}px`,
            }}
          >
            {/* Card 1: Scenario Overview */}
            <div className="modern-scenario-card">
              <div className="scenario-card-header">
                <span className="scenario-card-label">Scenario</span>
{result && (result as any).is_synthetic && (
                  <span className="synthetic-badge" title="Live sources failed; showing modeled fallback">
                    Synthetic fallback data
                  </span>
                )}
                <button className="scenario-change-btn" onClick={() => setShowScenarioModal(true)}>
                  Change
                </button>
              </div>

              {/* Mode Toggle: Manual Sliders vs Gen AI Assistant */}
              <div className="scenario-mode-toggle" role="tablist" aria-label="Scenario Input Mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarInputMode === 'manual'}
                  className={`scenario-mode-tab ${sidebarInputMode === 'manual' ? 'scenario-mode-tab--active' : ''}`}
                  onClick={() => setSidebarInputMode('manual')}
                  title="Configure disaster parameters manually using interactive sliders"
                >
                  <span className="scenario-mode-tab-icon">⚙️</span>
                  <span>Manual Sliders</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarInputMode === 'gen_ai'}
                  className={`scenario-mode-tab ${sidebarInputMode === 'gen_ai' ? 'scenario-mode-tab--active' : ''}`}
                  onClick={() => setSidebarInputMode('gen_ai')}
                  title="Use Gemini Flash-Lite to describe scenario in natural language and simulate automatically"
                >
                  <span className="scenario-mode-tab-icon">✨</span>
                  <span>Gen AI Mode</span>
                </button>
              </div>

              {sidebarInputMode === 'manual' ? (
                <>
                  <div className="scenario-title-row">
                <span>{disasterIcon(disasterType, 16)}</span>
                <span>
                  {disasterType === 'flood'
                    ? `${durationHours}-hour Extreme Rainfall`
                    : disasterType === 'cyclone'
                    ? `${durationHours}-hour Cyclone Landfall`
                    : disasterType === 'earthquake'
                    ? `Mw ${magnitude} Severe Earthquake (90s Rupture)`
                    : disasterType === 'wildfire'
                    ? `${durationHours < 1 ? `${Math.round(durationHours * 60)}-minute` : durationHours % 1 !== 0 ? `${Math.floor(durationHours)}h ${Math.round((durationHours % 1) * 60)}m` : `${durationHours}-hour`} Wildfire Spread`
                    : `Slope Failure & Debris Flow (15 min Runout)`}
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
                    {/* Live Cyclone Intensity & Surge Prediction Banner */}
                    <div
                      style={{
                        padding: '10px 12px',
                        marginBottom: '12px',
                        borderRadius: '8px',
                        background: 'rgba(15, 23, 42, 0.75)',
                        border: `1px solid ${cycloneCategoryInfo.border}`,
                        boxShadow: `0 0 14px ${cycloneCategoryInfo.border}22`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '15px' }}>🌀</span>
                          <span style={{ fontWeight: 700, fontSize: '12.5px', color: cycloneCategoryInfo.color }}>
                            {cycloneCategoryInfo.cat}
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: `${cycloneCategoryInfo.color}22`,
                            color: cycloneCategoryInfo.color,
                            border: `1px solid ${cycloneCategoryInfo.color}44`,
                            textTransform: 'uppercase',
                          }}
                        >
                          {cycloneCategoryInfo.badge}
                        </span>
                      </div>
                      <div style={{ fontSize: '10.5px', color: '#94a3b8', marginBottom: '8px' }}>
                        {cycloneCategoryInfo.imd}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        <div>
                          <div style={{ fontSize: '9.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Est. Coastal Surge</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#38bdf8' }}>+{cycloneEstimatedSurgeM.toFixed(2)} m</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '9.5px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Core Pressure Deficit</div>
                          <div style={{ fontSize: '12.5px', fontWeight: 700, color: '#f59e0b' }}>ΔP {Math.max(0, 1013 - centralPressure)} hPa</div>
                        </div>
                      </div>
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Movement Direction (Heading)</span>
                        <span className="scenario-slider-val">{getCompassLabel(cycloneDirection)}</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={0}
                        max={360}
                        step={5}
                        value={cycloneDirection}
                        onChange={(e) => setCycloneDirection(Number(e.target.value))}
                      />
                      <div className="scenario-pill-presets" style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                        {[
                          { label: 'NW 315°', val: 315 },
                          { label: 'N 0°', val: 0 },
                          { label: 'NE 45°', val: 45 },
                          { label: 'W 270°', val: 270 },
                          { label: 'SW 225°', val: 225 },
                          { label: 'E 90°', val: 90 },
                        ].map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            className={`scenario-preset-pill ${cycloneDirection === p.val ? 'scenario-preset-pill--active' : ''}`}
                            onClick={() => setCycloneDirection(p.val)}
                            style={{
                              fontSize: '10.5px',
                              padding: '2px 7px',
                              borderRadius: '4px',
                              background: cycloneDirection === p.val ? 'rgba(56, 189, 248, 0.25)' : 'rgba(30, 41, 59, 0.7)',
                              border: cycloneDirection === p.val ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.1)',
                              color: cycloneDirection === p.val ? '#38bdf8' : '#94a3b8',
                              cursor: 'pointer',
                            }}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Max Sustained Wind Speed</span>
                        <span className="scenario-slider-val" style={{ color: cycloneCategoryInfo.color, fontWeight: 700 }}>
                          {windSpeedKmh} km/h
                        </span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={60}
                        max={300}
                        step={5}
                        value={windSpeedKmh}
                        onChange={(e) => setWindSpeedKmh(Number(e.target.value))}
                      />
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta" style={{ alignItems: 'center' }}>
                        <span>Central Pressure (Pc)</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <button
                            type="button"
                            title="Auto-calculate physically consistent pressure from wind speed"
                            onClick={() => autoSyncPressureFromWind(windSpeedKmh)}
                            style={{
                              fontSize: '9.5px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: 'rgba(56, 189, 248, 0.15)',
                              border: '1px solid rgba(56, 189, 248, 0.4)',
                              color: '#38bdf8',
                              cursor: 'pointer',
                            }}
                          >
                            ⚡ Auto-Sync
                          </button>
                          <span className="scenario-slider-val">{centralPressure} hPa</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={880}
                        max={1005}
                        step={5}
                        value={centralPressure}
                        onChange={(e) => setCentralPressure(Number(e.target.value))}
                      />
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Cyclone Eye Wall Radius (Rmax)</span>
                        <span className="scenario-slider-val">{cycloneRadiusKm} km</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={15}
                        max={90}
                        step={1}
                        value={cycloneRadiusKm}
                        onChange={(e) => setCycloneRadiusKm(Number(e.target.value))}
                      />
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Outer Storm Gale Radius</span>
                        <span className="scenario-slider-val">{stormRadiusKm} km</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={60}
                        max={400}
                        step={10}
                        value={stormRadiusKm}
                        onChange={(e) => setStormRadiusKm(Number(e.target.value))}
                      />
                    </div>

                    <div className="scenario-slider-row">
                      <div className="scenario-slider-meta">
                        <span>Forward Translation Speed</span>
                        <span className="scenario-slider-val">{cycloneSpeedKmh} km/h</span>
                      </div>
                      <input
                        type="range"
                        className="scenario-range-input"
                        min={8}
                        max={65}
                        step={1}
                        value={cycloneSpeedKmh}
                        onChange={(e) => setCycloneSpeedKmh(Number(e.target.value))}
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
                {disasterType === 'wildfire' && (() => {
                  const wildfireMeta = (result as any)?.metadata || (result as any)?.simulation?.metadata;
                  return (
                    <div className="wildfire-accordion-group">
                    {/* SECTION 1: Ignition & Initial Extent */}
                    <div className={`wildfire-accordion-card ${openWildfireSection === 'ignition' ? 'wildfire-accordion-card--open' : ''}`}>
                      <button
                        type="button"
                        className="wildfire-accordion-header"
                        onClick={() => setOpenWildfireSection(openWildfireSection === 'ignition' ? null : 'ignition')}
                      >
                        <span className="wildfire-accordion-title">
                          <span>📍</span>
                          <span>Ignition &amp; Fire Origin</span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="wildfire-accordion-badge">
                            {initialFireRadiusM}m radius
                          </span>
                          <span className="wildfire-accordion-chevron">▶</span>
                        </div>
                      </button>

                      {openWildfireSection === 'ignition' && (
                        <div className="wildfire-accordion-body">
                          {/* Map Selection Button */}
                          <button
                            type="button"
                            className={`wildfire-pick-btn ${isPickingIgnition ? 'wildfire-pick-btn--active' : ''}`}
                            onClick={() => setIsPickingIgnition(!isPickingIgnition)}
                          >
                            <span>{isPickingIgnition ? '🎯' : '📍'}</span>
                            <span>
                              {isPickingIgnition
                                ? 'Tap anywhere on map to place fire origin...'
                                : 'Select Ignition Point on Map'}
                            </span>
                          </button>

                          {/* Selected Coordinate Readout */}
                          <div className="wildfire-coord-badge">
                            <span>Selected Origin:</span>
                            <strong>
                              {ignitionLat !== null && ignitionLon !== null
                                ? `${ignitionLat.toFixed(4)}°N, ${ignitionLon.toFixed(4)}°E`
                                : '17.385°N, 78.486°E'}
                            </strong>
                          </div>

                          {bbox && (
                            <button
                              type="button"
                              className="wildfire-btn-subtle"
                              onClick={() => {
                                setIgnitionLat(Number(((bbox.north + bbox.south) / 2).toFixed(4)));
                                setIgnitionLon(Number(((bbox.east + bbox.west) / 2).toFixed(4)));
                              }}
                            >
                              📍 Reset to AOI Center
                            </button>
                          )}

                          <div className="scenario-slider-row" style={{ marginTop: 2 }}>
                            <div className="scenario-slider-meta">
                              <span>🔥 Initial Fire Radius</span>
                              <span className="scenario-slider-val">{initialFireRadiusM} m</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={5}
                              max={100}
                              step={5}
                              value={initialFireRadiusM}
                              onChange={(e) => setInitialFireRadiusM(Number(e.target.value))}
                            />
                            <div className="wildfire-helper-text">Starting fire footprint at t=0h (seeds ignition cells)</div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* SECTION 2: Atmosphere & Fire Weather */}
                    <div className={`wildfire-accordion-card ${openWildfireSection === 'weather' ? 'wildfire-accordion-card--open' : ''}`}>
                      <button
                        type="button"
                        className="wildfire-accordion-header"
                        onClick={() => setOpenWildfireSection(openWildfireSection === 'weather' ? null : 'weather')}
                      >
                        <span className="wildfire-accordion-title">
                          <span>🌬️</span>
                          <span>Atmospheric &amp; Weather</span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="wildfire-accordion-badge">
                            {wildfireWindSpeed} km/h • {wildfireTempC}°C
                          </span>
                          <span className="wildfire-accordion-chevron">▶</span>
                        </div>
                      </button>

                      {openWildfireSection === 'weather' && (
                        <div className="wildfire-accordion-body">
                          {/* Wind Speed */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>🌬️ Wind Speed</span>
                              <span className="scenario-slider-val">{wildfireWindSpeed} km/h</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={0}
                              max={80}
                              step={1}
                              value={wildfireWindSpeed}
                              onChange={(e) => setWildfireWindSpeed(Number(e.target.value))}
                            />
                            <div className="wildfire-helper-text">Rothermel wind propagation factor φw &amp; Huygens elongation</div>
                          </div>

                          {/* Wind Direction */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>🧭 Wind Direction</span>
                              <span className="scenario-slider-val">{getCompassLabel(wildfireWindDir)}</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={0}
                              max={359}
                              step={5}
                              value={wildfireWindDir}
                              onChange={(e) => setWildfireWindDir(Number(e.target.value))}
                            />
                            <div className="wildfire-quick-chips">
                              <button
                                type="button"
                                className={`wildfire-chip-btn ${wildfireWindDir === 135 ? 'wildfire-chip-btn--active' : ''}`}
                                onClick={() => setWildfireWindDir(135)}
                              >
                                NW → SE (135°)
                              </button>
                              <button
                                type="button"
                                className={`wildfire-chip-btn ${wildfireWindDir === 90 ? 'wildfire-chip-btn--active' : ''}`}
                                onClick={() => setWildfireWindDir(90)}
                              >
                                W → E (90°)
                              </button>
                              <button
                                type="button"
                                className={`wildfire-chip-btn ${wildfireWindDir === 180 ? 'wildfire-chip-btn--active' : ''}`}
                                onClick={() => setWildfireWindDir(180)}
                              >
                                N → S (180°)
                              </button>
                              <button
                                type="button"
                                className={`wildfire-chip-btn ${wildfireWindDir === 45 ? 'wildfire-chip-btn--active' : ''}`}
                                onClick={() => setWildfireWindDir(45)}
                              >
                                SW → NE (45°)
                              </button>
                            </div>
                          </div>

                          {/* Air Temperature */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>🌡️ Temperature</span>
                              <span className="scenario-slider-val">{wildfireTempC} °C</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={20}
                              max={50}
                              step={1}
                              value={wildfireTempC}
                              onChange={(e) => setWildfireTempC(Number(e.target.value))}
                            />
                            <div className="wildfire-helper-text">Accelerates fine fuel desiccation and fire convective column</div>
                          </div>

                          {/* Relative Humidity */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>💧 Relative Humidity</span>
                              <span className="scenario-slider-val">{wildfireHumidityPct} %</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={5}
                              max={80}
                              step={1}
                              value={wildfireHumidityPct}
                              onChange={(e) => setWildfireHumidityPct(Number(e.target.value))}
                            />
                            <div className="wildfire-helper-text">Drier air (&lt;30%) drastically lowers fuel moisture equilibrium</div>
                          </div>

                          {/* Recent Rainfall */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>🌧️ Recent Rainfall</span>
                              <span className="scenario-slider-val">{recentRainfallMm} mm</span>
                            </div>
                            <input
                              type="range"
                              className="scenario-range-input"
                              min={0}
                              max={30}
                              step={1}
                              value={recentRainfallMm}
                              onChange={(e) => setRecentRainfallMm(Number(e.target.value))}
                            />
                            <div className="wildfire-helper-text">Pre-fire moisture wetting dampens flame intensity</div>
                          </div>

                          {/* Duration */}
                          <div className="scenario-slider-row">
                            <div className="scenario-slider-meta">
                              <span>⏱️ Burn Duration</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="scenario-slider-val">
                                  {durationHours < 1
                                    ? `${Math.round(durationHours * 60)} min`
                                    : durationHours % 1 !== 0
                                    ? `${Math.floor(durationHours)}h ${Math.round((durationHours % 1) * 60)}m`
                                    : `${durationHours} hours`}
                                </span>
                                {/* Min/Hr unit toggle */}
                                <div className="map-timeline-unit-selector" style={{ padding: '2px' }}>
                                  <button
                                    type="button"
                                    className={`map-timeline-unit-btn${wildfireDurationUnit === 'minutes' ? ' map-timeline-unit-btn--active' : ''}`}
                                    onClick={() => setWildfireDurationUnit('minutes')}
                                    title="Set duration in minutes (fine control: 5–180 min)"
                                  >min</button>
                                  <button
                                    type="button"
                                    className={`map-timeline-unit-btn${wildfireDurationUnit === 'hours' ? ' map-timeline-unit-btn--active' : ''}`}
                                    onClick={() => setWildfireDurationUnit('hours')}
                                    title="Set duration in hours (1–24 h)"
                                  >hr</button>
                                </div>
                              </div>
                            </div>
                            {/* Quick presets adapt to selected unit */}
                            <div className="wildfire-quick-chips" style={{ marginBottom: 8 }}>
                              {wildfireDurationUnit === 'minutes'
                                ? [15, 30, 45, 60, 90, 120, 180].map((m) => (
                                    <button
                                      key={m}
                                      type="button"
                                      className={`wildfire-chip-btn ${Math.round(durationHours * 60) === m ? 'wildfire-chip-btn--active' : ''}`}
                                      onClick={() => setDurationHours(m / 60)}
                                    >
                                      {m}m
                                    </button>
                                  ))
                                : [0.5, 1, 2, 4, 8, 12, 24].map((h) => (
                                    <button
                                      key={h}
                                      type="button"
                                      className={`wildfire-chip-btn ${durationHours === h ? 'wildfire-chip-btn--active' : ''}`}
                                      onClick={() => setDurationHours(h)}
                                    >
                                      {h < 1 ? `${Math.round(h * 60)}m` : `${h}h`}
                                    </button>
                                  ))}
                            </div>
                            {wildfireDurationUnit === 'minutes' ? (
                              <input
                                type="range"
                                className="scenario-range-input"
                                min={5}
                                max={180}
                                step={5}
                                value={Math.round(durationHours * 60)}
                                onChange={(e) => setDurationHours(Number(e.target.value) / 60)}
                              />
                            ) : (
                              <input
                                type="range"
                                className="scenario-range-input"
                                min={0.25}
                                max={24}
                                step={0.25}
                                value={durationHours}
                                onChange={(e) => setDurationHours(Number(e.target.value))}
                              />
                            )}
                            <div className="wildfire-helper-text">
                              {wildfireDurationUnit === 'minutes'
                                ? 'Fine-grained minute control — simulation engine auto-scales frames for smooth animation'
                                : 'Hour-level duration — each frame captures ~2–3 min of real fire advance'}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* SECTION 3: Fuel Model & Topography (DEM) - Automated from DEM */}
                    <div className={`wildfire-accordion-card ${openWildfireSection === 'fuel' ? 'wildfire-accordion-card--open' : ''}`}>
                      <button
                        type="button"
                        className="wildfire-accordion-header"
                        onClick={() => setOpenWildfireSection(openWildfireSection === 'fuel' ? null : 'fuel')}
                      >
                        <span className="wildfire-accordion-title">
                          <span>🌿</span>
                          <span>Fuel &amp; Topography (DEM)</span>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <span className="wildfire-accordion-badge">
                            {wildfireMeta?.slope_deg !== undefined
                              ? `⛰️ ${wildfireMeta.slope_deg}° • ${wildfireMeta.fuel_type || 'Auto'}`
                              : '🤖 Auto-Decided from DEM'}
                          </span>
                          <span className="wildfire-accordion-chevron">▶</span>
                        </div>
                      </button>

                      {openWildfireSection === 'fuel' && (
                        <div className="wildfire-accordion-body">
                          <div className="wildfire-auto-dem-card">
                            <div className="wildfire-auto-dem-header">
                              <span className="wildfire-auto-dem-badge">⚡ AUTOMATED DEM ENGINE ACTIVE</span>
                              <span className="wildfire-auto-dem-tag">No manual input required</span>
                            </div>
                            <p className="wildfire-auto-dem-desc">
                              The simulation engine automatically calculates per-cell terrain slope gradients, directional solar aspect, and vegetation fuel beds directly from the 3D Digital Elevation Model (DEM) and weather conditions.
                            </p>

                            <div className="wildfire-dem-features-grid">
                              {/* 1. Slope */}
                              <div className="wildfire-dem-feature-item">
                                <div className="wildfire-dem-feature-title">
                                  <span>⛰️</span>
                                  <strong>Slope Gradients (∇z)</strong>
                                </div>
                                <div className="wildfire-dem-feature-body">
                                  Per-cell 90m gradient calculated via spatial elevation differentials. Uphill spread accelerates dramatically (φs = 5.275·tan²θ) and retards downhill.
                                </div>
                                {wildfireMeta?.slope_deg !== undefined && (
                                  <div className="wildfire-dem-feature-stat">
                                    <span>Mean: <strong>{wildfireMeta.slope_deg}°</strong> | Max: <strong>{wildfireMeta.max_slope_deg}°</strong> | At Pin: <strong>{wildfireMeta.ignition_slope_deg}°</strong></span>
                                  </div>
                                )}
                              </div>

                              {/* 2. Aspect */}
                              <div className="wildfire-dem-feature-item">
                                <div className="wildfire-dem-feature-title">
                                  <span>🧭</span>
                                  <strong>Solar Aspect Vector</strong>
                                </div>
                                <div className="wildfire-dem-feature-body">
                                  Per-cell directional exposure vector atan2(-∂z/∂x, ∂z/∂y). South &amp; West facing slopes receive increased solar drying and fuel desiccation.
                                </div>
                                {wildfireMeta?.aspect_direction && (
                                  <div className="wildfire-dem-feature-stat">
                                    <span>Dominant: <strong>{String(wildfireMeta.aspect_direction).toUpperCase()}</strong> ({wildfireMeta.aspect_deg}°)</span>
                                  </div>
                                )}
                              </div>

                              {/* 3. Fuel Bed */}
                              <div className="wildfire-dem-feature-item">
                                <div className="wildfire-dem-feature-title">
                                  <span>🌿</span>
                                  <strong>Vegetation Fuel Bed</strong>
                                </div>
                                <div className="wildfire-dem-feature-body">
                                  Heterogeneous Rothermel model inferred from terrain relief: timber forest canopy on ridges (&gt;16°), chaparral shrubs on mid-slopes, dry grass on lowlands.
                                </div>
                                {wildfireMeta?.fuel_type_name && (
                                  <div className="wildfire-dem-feature-stat">
                                    <span>Model: <strong>{wildfireMeta.fuel_type_name}</strong></span>
                                  </div>
                                )}
                              </div>

                              {/* 4. Equilibrium Moisture */}
                              <div className="wildfire-dem-feature-item">
                                <div className="wildfire-dem-feature-title">
                                  <span>💦</span>
                                  <strong>Equilibrium Moisture</strong>
                                </div>
                                <div className="wildfire-dem-feature-body">
                                  Natural equilibrium fuel moisture computed dynamically from temperature ({wildfireTempC}°C), humidity ({wildfireHumidityPct}%), and rainfall ({recentRainfallMm}mm).
                                </div>
                                {wildfireMeta?.fuel_moisture_pct !== undefined && (
                                  <div className="wildfire-dem-feature-stat">
                                    <span>Equilibrium: <strong>{wildfireMeta.fuel_moisture_pct}%</strong> (Eff: {wildfireMeta.effective_moisture_pct}%)</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="wildfire-dem-gis-note">
                              🏘️ <strong>GIS Infrastructure Integration</strong>: Building footprints and road corridors automatically intersect the continuous burn perimeter to quantify exposed assets.
                            </div>

                            {/* Optional Manual Overrides Toggle */}
                            <div style={{ marginTop: '2px' }}>
                              <button
                                type="button"
                                className="wildfire-override-toggle-btn"
                                onClick={() => setShowManualFuelOverrides(!showManualFuelOverrides)}
                              >
                                <span>{showManualFuelOverrides ? '▲ Hide Manual Overrides' : '⚙️ Advanced Overrides (Optional)'}</span>
                                <span style={{ fontSize: '10px', color: '#38bdf8' }}>
                                  {showManualFuelOverrides ? 'Manual Mode' : 'Using Automated DEM analysis'}
                                </span>
                              </button>

                              {showManualFuelOverrides && (
                                <div className="wildfire-override-panel">
                                  <div className="scenario-slider-row">
                                    <div className="scenario-slider-meta">
                                      <span>Override Fuel Model</span>
                                    </div>
                                    <select
                                      className="wildfire-select-input"
                                      value={fuelType}
                                      onChange={(e) => setFuelType(e.target.value)}
                                    >
                                      <option value="auto">Auto (Infer from 3D DEM relief &amp; slopes)</option>
                                      <option value="grass">Grassland / Dry Savanna (Fast spread, R0=290m/h)</option>
                                      <option value="shrub">Shrubland / Dense Chaparral (R0=195m/h)</option>
                                      <option value="forest">Forest / Timber Canopy (High flame load, R0=85m/h)</option>
                                      <option value="agriculture">Agricultural Farmland (R0=145m/h)</option>
                                    </select>
                                  </div>

                                  <div className="scenario-slider-row">
                                    <div className="scenario-slider-meta">
                                      <span>Override Fuel Moisture</span>
                                      <span className="scenario-slider-val">{fuelMoisturePct === 'auto' ? 'Auto' : `${fuelMoisturePct}%`}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                      <button
                                        type="button"
                                        className={`wildfire-chip-btn ${fuelMoisturePct === 'auto' ? 'wildfire-chip-btn--active' : ''}`}
                                        onClick={() => setFuelMoisturePct('auto')}
                                      >
                                        Auto
                                      </button>
                                      <input
                                        type="range"
                                        className="scenario-range-input"
                                        min={2}
                                        max={25}
                                        step={1}
                                        value={typeof fuelMoisturePct === 'number' ? fuelMoisturePct : 8}
                                        onChange={(e) => setFuelMoisturePct(Number(e.target.value))}
                                      />
                                    </div>
                                  </div>

                                  <div className="scenario-slider-row">
                                    <div className="scenario-slider-meta">
                                      <span>Override Slope Angle</span>
                                      <span className="scenario-slider-val">{slopeDeg === 'auto' ? 'Auto (DEM)' : `${slopeDeg}°`}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                      <button
                                        type="button"
                                        className={`wildfire-chip-btn ${slopeDeg === 'auto' ? 'wildfire-chip-btn--active' : ''}`}
                                        onClick={() => setSlopeDeg('auto')}
                                      >
                                        Auto (DEM)
                                      </button>
                                      <input
                                        type="range"
                                        className="scenario-range-input"
                                        min={0}
                                        max={45}
                                        step={1}
                                        value={typeof slopeDeg === 'number' ? slopeDeg : 15}
                                        onChange={(e) => setSlopeDeg(Number(e.target.value))}
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
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
                        <span>Antecedent Saturation</span>
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
                    <div style={{ fontSize: 11, color: '#94a3b8', padding: '2px 0 4px 0' }}>
                      ⏱️ Catastrophic Runout Event: 15 minutes
                    </div>
                  </>
                )}
              </div>
              <button
                className="btn-run-simulation-primary"
                onClick={() => executeSimulation()}
                disabled={loading}
              >
                {loading ? 'Calculating Simulation…' : <><IconPlay size={12} color="#ffffff" className="svg-icon-inline" /> Run Simulation</>}
              </button>
            </>
          ) : (
            <div className="genai-scenario-panel">
              {/* Top Meta Bar: Auto-Run Toggle */}
              <div className="genai-top-meta-row" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
                <label className="genai-autorun-label" title="Automatically trigger physics simulation after Gemini assigns parameters">
                  <input
                    type="checkbox"
                    checked={aiAutoRun}
                    onChange={(e) => setAiAutoRun(e.target.checked)}
                  />
                  <span>Auto-run simulation</span>
                </label>
              </div>

              {!aiKeyStatus.configured && (
                <div
                  style={{
                    padding: '8px 10px',
                    margin: '0 0 10px 0',
                    borderRadius: '6px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '11px',
                    color: '#fde68a',
                  }}
                >
                  <span>⚠️ Gemini API key not configured</span>
                  <button
                    type="button"
                    onClick={() => setSettingsPageOpen(true)}
                    style={{
                      background: '#f59e0b',
                      color: '#0f172a',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '2px 8px',
                      fontWeight: 700,
                      fontSize: '10.5px',
                      cursor: 'pointer',
                    }}
                  >
                    Set Key in Settings
                  </button>
                </div>
              )}

              {/* Chat Conversation Stream */}
              <div className="genai-chat-stream">
                {aiChatHistory.map((msg, idx) => (
                  <div key={idx} className={`genai-chat-bubble genai-chat-bubble--${msg.role}`}>
                    <div className="genai-bubble-header">
                      <span>{msg.role === 'user' ? '👤 You' : '🤖 Gemini Assistant'}</span>
                      <span className="genai-msg-time">{msg.timestamp}</span>
                    </div>
                    <div className="genai-bubble-content">{msg.text}</div>

                    {/* Extracted Parameters Card in Assistant Message */}
                    {msg.parsed && msg.parsed.parameters && (
                      <div className="genai-parsed-card">
                        <div className="genai-parsed-header">
                          <span className="genai-parsed-type-badge">
                            <span>{disasterIcon(msg.parsed.disaster_type || disasterType, 13)}</span>
                            <span>{msg.parsed.disaster_type || disasterType}</span>
                          </span>
                          <span className="genai-parsed-source-tag">
                            {msg.parsed.source || 'Gemini Flash-Lite'}
                          </span>
                        </div>

                        <div className="genai-params-chips">
                          {Object.entries(msg.parsed.parameters).map(([k, v]) => (
                            <span key={k} className="genai-param-chip">
                              {k.replace(/_/g, ' ')}: <strong>{Number(v).toFixed(1)}</strong>
                            </span>
                          ))}
                        </div>

                        <div className="genai-parsed-actions">
                          <button
                            type="button"
                            className="genai-run-now-btn"
                            onClick={() =>
                              executeSimulation({
                                disaster_type: msg.parsed.disaster_type || disasterType,
                                ...msg.parsed.parameters,
                              })
                            }
                            disabled={loading}
                          >
                            🚀 Run Simulation
                          </button>
                          <button
                            type="button"
                            className="genai-tweak-manual-btn"
                            onClick={() => setSidebarInputMode('manual')}
                            title="Switch to Manual Mode to inspect or adjust these parameters on the sliders"
                          >
                            ✏️ Tweak Sliders
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {aiChatLoading && (
                  <div className="genai-chat-bubble genai-chat-bubble--assistant">
                    <div className="genai-bubble-header">
                      <span>🤖 Gemini Assistant</span>
                      <span className="genai-msg-time">Thinking...</span>
                    </div>
                    <div className="genai-bubble-content" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#38bdf8' }}>
                      <span className="spinner-inline" />
                      <span>Gemini 3.5 Flash-Lite is parsing disaster physics parameters...</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Suggested Prompts (When history is short) */}
              {aiChatHistory.length <= 2 && (
                <div className="genai-suggestions-box">
                  <div className="genai-suggestions-title">💡 Quick Scenario Prompts:</div>
                  <div className="genai-suggestions-pills">
                    {[
                      '🌊 Flash Flood: 350mm rain over 8 hours with 2.0m storm surge',
                      '⚡ Mw 7.4 Major Earthquake: 10km shallow hypocenter',
                      '🔥 Wildfire: 50 km/h wind heading SE, 38°C dry timber',
                      '⛰️ Landslide: Heavy continuous rain on steep hillside slopes',
                    ].map((suggestion, sIdx) => (
                      <button
                        key={sIdx}
                        type="button"
                        className="genai-suggestion-pill"
                        onClick={() => handleGenAISubmit(suggestion)}
                        disabled={aiChatLoading}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Chat Input Form */}
              <form
                className="genai-input-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleGenAISubmit();
                }}
              >
                <div className="genai-input-wrapper">
                  <textarea
                    className="genai-textarea"
                    placeholder="Type any scenario (e.g. 400mm rainfall in 12h, 2m surge)..."
                    value={aiChatPrompt}
                    onChange={(e) => setAiChatPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleGenAISubmit();
                      }
                    }}
                    disabled={aiChatLoading}
                    rows={2}
                  />
                    <button
                      type="submit"
                      className="genai-send-btn"
                      disabled={aiChatLoading || !aiChatPrompt.trim()}
                      title="Submit prompt to Gemini 3.5 Flash-Lite"
                    >
                    {aiChatLoading ? 'Parsing…' : '✨ Generate'}
                  </button>
                </div>
                <div className="genai-helper-hint">
                  Press Enter ↵ to send • Parameters sync directly with manual sliders
                </div>
              </form>
            </div>
          )}
        </div>

            {/* Card 2: Impact Summary (2x2 Grid) */}
            <div className="modern-impact-card">
              <div className="impact-card-title">Impact Summary (Current View)</div>
              <div className="impact-2x2-grid">
                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(2, 132, 199, 0.25)', color: '#38bdf8' }}>
                    {disasterIcon(disasterType, 16)}
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? `${(impact.flooded_area_km2 ?? impact.affected_area_km2 ?? 0).toFixed(2)} km²` : '—'}
                    </div>
                    <div className="impact-2x2-label">
                      {disasterType === 'flood' ? 'Estimated Flooded Area' : disasterType === 'wildfire' ? 'Estimated Burn Area' : disasterType === 'earthquake' ? 'Shaking Area (MMI VI+)' : disasterType === 'landslide' ? 'Unstable Slope Area' : disasterType === 'cyclone' ? 'Storm Impact Area' : 'Estimated Impact Area'}
                    </div>
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(168, 85, 247, 0.25)', color: '#c084fc' }}>
                    <IconPopulation size={16} />
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? (impact.estimated_population_exposed ?? 0).toLocaleString() : '—'}
                    </div>
                    <div className="impact-2x2-label">Population Exposed</div>
                    {result && impact && disasterType === 'earthquake' && (impact.estimated_fatalities || impact.estimated_injuries) ? (
                      <div className="impact-2x2-sub">≈ {impact.estimated_fatalities ?? 0} deaths • {(impact.estimated_injuries ?? 0).toLocaleString()} injured</div>
                    ) : result && impact && (disasterType === 'flood' || disasterType === 'cyclone') && (impact.estimated_displaced ?? 0) > 0 ? (
                      <div className="impact-2x2-sub">≈ {(impact.estimated_displaced ?? 0).toLocaleString()} displaced</div>
                    ) : result && impact && disasterType === 'wildfire' && (impact.population_smoke_exposed ?? 0) > 0 ? (
                      <div className="impact-2x2-sub">≈ {(impact.population_smoke_exposed ?? 0).toLocaleString()} smoke-exposed</div>
                    ) : result && impact && disasterType === 'landslide' && (impact.population_at_risk ?? 0) > 0 ? (
                      <div className="impact-2x2-sub">≈ {(impact.population_at_risk ?? 0).toLocaleString()} at risk</div>
                    ) : null}
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#60a5fa' }}>
                    <IconBuilding size={16} />
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && impact ? (impact.buildings_affected ?? 0).toLocaleString() : '—'}
                    </div>
                    <div className="impact-2x2-label">{disasterType === 'flood' ? 'Buildings Flooded' : disasterType === 'wildfire' ? 'Structures Burned' : disasterType === 'landslide' ? 'Buildings Buried / Damaged' : 'Buildings Damaged'}</div>
                    {result && impact && (impact.buildings_summary?.buildings_destroyed ?? 0) > 0 && (
                      <div className="impact-2x2-sub">{(impact.buildings_summary?.buildings_destroyed ?? 0).toLocaleString()} destroyed</div>
                    )}
                  </div>
                </div>

                <div className="impact-2x2-tile">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                    <IconRoad size={16} />
                  </div>
                  <div className="impact-2x2-info">
                    <div className="impact-2x2-val">
                      {result && roadStatus ? roadStatus.closed : '—'}
                    </div>
                    <div className="impact-2x2-label">{disasterType === 'flood' ? 'Road Segments Closed' : disasterType === 'wildfire' ? 'Roads Blocked by Fire' : disasterType === 'landslide' ? 'Roads Buried / Blocked' : disasterType === 'earthquake' ? 'Roads Blocked by Debris' : 'Roads Blocked by Wind'}</div>
                  </div>
                </div>

                <div className="impact-2x2-tile impact-2x2-tile--full">
                  <div className="impact-2x2-icon-box" style={{ background: 'rgba(245, 158, 11, 0.25)', color: '#fbbf24' }}>
                    <IconAlertTriangle size={16} />
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
                {realFacilities.length > 4 && (
                  <button
                    className="facilities-view-all-btn"
                    onClick={() => setShowAllFacilities((v) => !v)}
                    aria-expanded={showAllFacilities}
                  >
                    {showAllFacilities ? 'Show Less' : `View All (${realFacilities.length}) ↗`}
                  </button>
                )}
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
                      <div
                        className="facility-list-row"
                        key={fac.id || idx}
                        role="button"
                        tabIndex={0}
                        title={`Show ${fac.name} on map`}
                        aria-label={`Show ${fac.name} on map`}
                        onClick={() => {
                          setSelectedRoad(null);
                          setFocusedFacility({ fac, nonce: Date.now() });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedRoad(null);
                            setFocusedFacility({ fac, nonce: Date.now() });
                          }
                        }}
                      >
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
                    <span className="panel-standby-icon"><IconLocationPin size={20} /></span>
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
                  <span className="ai-insight-symbol"><IconInsight size={14} /></span>
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
          </ErrorBoundary>
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
              <button className="modal-close-btn" onClick={() => setShowScenarioModal(false)} aria-label="Close scenario dialog">✕</button>
            </div>

            {/* Natural Language Prompt Box */}
            <form className="nl-prompt-form" onSubmit={handleNaturalLanguageSubmit}>
              <div className="nl-input-wrapper">
                <span><IconInsight size={15} color="#38bdf8" className="svg-icon-inline" /></span>
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
                  <label htmlFor="param-rainfall">Rainfall: {rainfallMm} mm</label>
                  <input id="param-rainfall" type="range" min="20" max="1500" step="10" value={rainfallMm} onChange={(e) => setRainfallMm(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label htmlFor="param-duration">Duration: {durationHours} hours</label>
                  <input id="param-duration" type="range" min="1" max="72" step="1" value={durationHours} onChange={(e) => setDurationHours(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label htmlFor="param-surge">Coastal Storm Surge: {seaLevelSurge} m</label>
                  <input id="param-surge" type="range" min="0" max="8" step="0.2" value={seaLevelSurge} onChange={(e) => setSeaLevelSurge(Number(e.target.value))} />
                </div>
              </div>
            )}
            {disasterType === 'earthquake' && (
              <div className="param-controls-grid">
                <div className="param-field">
                  <label htmlFor="param-magnitude">Magnitude: {magnitude} Mw</label>
                  <input id="param-magnitude" type="range" min="5.0" max="9.0" step="0.1" value={magnitude} onChange={(e) => setMagnitude(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label htmlFor="param-depth">Focal Depth: {depthKm} km</label>
                  <input id="param-depth" type="range" min="2" max="100" step="2" value={depthKm} onChange={(e) => setDepthKm(Number(e.target.value))} />
                </div>
              </div>
            )}
            {disasterType === 'cyclone' && (
              <div className="param-controls-grid">
                <div className="param-field">
                  <label htmlFor="param-wind">Max Wind Speed: {windSpeedKmh} km/h</label>
                  <input id="param-wind" type="range" min="60" max="280" step="5" value={windSpeedKmh} onChange={(e) => setWindSpeedKmh(Number(e.target.value))} />
                </div>
                <div className="param-field">
                  <label htmlFor="param-pressure">Central Pressure: {centralPressure} hPa</label>
                  <input id="param-pressure" type="range" min="890" max="1000" step="5" value={centralPressure} onChange={(e) => setCentralPressure(Number(e.target.value))} />
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

      {/* ─── Settings Page (full view, opened from sidebar) ─── */}
      {settingsPageOpen && (
        <div className="settings-page">
          <div className="settings-page-header">
            <button className="settings-back-btn" onClick={() => setSettingsPageOpen(false)} aria-label="Back to dashboard">
              ← Back
            </button>
            <div>
              <div className="settings-page-title">Settings</div>
              <div className="settings-page-sub">Display performance and map density</div>
            </div>
          </div>
          <div className="settings-page-body">
            <div className="modal-section-title">Buildings on Map</div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-title">Building density</div>
                <div className="settings-row-sub">Maximum shows every house (can slow down large areas). Medium caps the count and hides buildings until zoomed to street level.</div>
              </div>
              <div className="settings-pill-group" role="group" aria-label="Building density">
                <button
                  className={`settings-pill ${buildingDensity === 'medium' ? 'settings-pill--active' : ''}`}
                  onClick={() => setBuildingDensity('medium')}
                >
                  Medium
                </button>
                <button
                  className={`settings-pill ${buildingDensity === 'maximum' ? 'settings-pill--active' : ''}`}
                  onClick={() => setBuildingDensity('maximum')}
                >
                  Maximum
                </button>
              </div>
            </div>

            {/* Google Gemini AI API Key Configuration */}
            <div className="modal-section-title" style={{ marginTop: '28px' }}>AI Configuration (Google Gemini)</div>
            <div
              className="settings-row"
              style={{
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: '14px',
                background: 'rgba(15, 23, 42, 0.75)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '16px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
                <div className="settings-row-text" style={{ flex: 1 }}>
                  <div className="settings-row-title" style={{ fontSize: '14.5px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>⚡ Google Gemini 3.5 Flash-Lite API Key</span>
                  </div>
                  <div className="settings-row-sub" style={{ marginTop: '4px', fontSize: '12px', color: '#94a3b8' }}>
                    Powers natural language scenario extraction and grounded AI post-disaster analysis. The key is verified and stored in <code>backend/.env</code>.
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11.5px',
                      fontWeight: 600,
                      padding: '4px 10px',
                      borderRadius: '6px',
                      background: aiKeyStatus.configured ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      border: `1px solid ${aiKeyStatus.configured ? 'rgba(34, 197, 94, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
                      color: aiKeyStatus.configured ? '#4ade80' : '#fbbf24',
                    }}
                  >
                    <span>{aiKeyStatus.configured ? '●' : '○'}</span>
                    <span>{aiKeyStatus.configured ? `Active (${aiKeyStatus.masked_key || 'Configured'})` : 'Not Configured'}</span>
                  </span>
                </div>
              </div>

              <form onSubmit={handleSaveAiKey} style={{ display: 'flex', gap: '10px', width: '100%' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    type={showAiKeyText ? 'text' : 'password'}
                    placeholder={aiKeyStatus.configured ? 'Enter new Gemini key to update (AIzaSy...)' : 'Paste your Gemini API key (AIzaSy...)'}
                    value={inputAiKey}
                    onChange={(e) => setInputAiKey(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 42px 10px 14px',
                      background: 'rgba(2, 6, 23, 0.85)',
                      border: '1px solid rgba(56, 189, 248, 0.3)',
                      borderRadius: '6px',
                      color: '#ffffff',
                      fontSize: '13px',
                      fontFamily: 'monospace',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowAiKeyText(!showAiKeyText)}
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '4px',
                    }}
                    title={showAiKeyText ? 'Hide API Key' : 'Show API Key'}
                  >
                    {showAiKeyText ? '🙈' : '👁️'}
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={savingAiKey || !inputAiKey.trim()}
                  style={{
                    background: inputAiKey.trim() ? '#38bdf8' : 'rgba(56, 189, 248, 0.3)',
                    color: '#0b1320',
                    fontWeight: 700,
                    fontSize: '13px',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '0 20px',
                    cursor: inputAiKey.trim() && !savingAiKey ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.2s',
                  }}
                >
                  {savingAiKey ? 'Saving…' : 'Save & Connect'}
                </button>
              </form>

              {aiKeySaveMsg && (
                <div
                  style={{
                    padding: '9px 14px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 500,
                    background: aiKeySaveMsg.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    border: `1px solid ${aiKeySaveMsg.type === 'success' ? '#22c55e' : '#ef4444'}`,
                    color: aiKeySaveMsg.type === 'success' ? '#4ade80' : '#f87171',
                  }}
                >
                  {aiKeySaveMsg.text}
                </div>
              )}

              <div style={{ fontSize: '11.5px', color: '#64748b', lineHeight: 1.6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '10px' }}>
                🔑 <strong>Get your API Key</strong>: Generate a free key from{' '}
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#38bdf8', textDecoration: 'underline' }}
                >
                  Google AI Studio (aistudio.google.com/apikey)
                </a>.
                <br />
                📁 <strong>Alternative</strong>: You can also set it manually in <code>backend/.env</code> as <code>GEMINI_API_KEY=&quot;AIzaSy...&quot;</code> or export it in your terminal.
              </div>
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
              <button className="modal-close-btn" onClick={() => setShowProvenanceDrawer(false)} aria-label="Close data provenance drawer">✕</button>
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
