import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  analyzeResearchField,
  chatResearchField,
  detectObjects,
  ResearchFieldData,
} from '../services/api';
import { BoundingBox, SatDetection, SatStats } from '../types';
import { voiceEngine } from '../utils/voice';
import {
  IconSearch,
  IconSatellite,
  IconSettings,
  IconSparkles,
  IconBolt,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconAlertTriangle,
  IconBot,
  IconVolume2,
  IconVolumeX,
  IconCamera,
  IconCopy,
  IconCheck,
  IconX,
  IconSprout,
  IconCloudSun,
} from './Icons';

interface ResearchPageProps {
  onBack: () => void;
  onSendToSimulation?: (locationName: string, bbox: BoundingBox) => void;
}

interface HistoryItem {
  timestamp: string;
  data: ResearchFieldData;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const WEATHER_CODES: Record<number, string> = {
  0: 'Clear Sky',
  1: 'Mainly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Rime Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Dense Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  80: 'Rain Showers',
  81: 'Moderate Showers',
  82: 'Violent Showers',
  85: 'Snow Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm + Hail',
  99: 'Severe Thunderstorm',
};

export default function ResearchPage({ onBack, onSendToSimulation }: ResearchPageProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const opticalGroupRef = useRef<L.FeatureGroup | null>(null);
  const drawStartRef = useRef<L.LatLng | null>(null);

  // States
  const [isDrawing, setIsDrawing] = useState(false);
  const [selectedBounds, setSelectedBounds] = useState<L.LatLngBounds | null>(null);
  const [selectedCenter, setSelectedCenter] = useState<L.LatLng | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<'current' | 'history'>('current');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [reportData, setReportData] = useState<ResearchFieldData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Optical Computer Vision Engine (ExG canopy, NDWI water, building contours)
  const [opticalCvLoading, setOpticalCvLoading] = useState(false);
  const [opticalCvData, setOpticalCvData] = useState<{ detections: SatDetection[]; stats: SatStats } | null>(null);
  const [opticalCvVisible, setOpticalCvVisible] = useState(true);

  // Search & Autocomplete
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);

  // Weather Widget
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [weatherData, setWeatherData] = useState<{
    location: string;
    temp: number;
    feels: number;
    humidity: number;
    wind: number;
    visibility: number;
    desc: string;
    lat: number;
    lon: number;
  } | null>(null);

  // Street View PiP
  const [streetViewOpen, setStreetViewOpen] = useState(false);
  const [streetViewCoords, setStreetViewCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pipPos, setPipPos] = useState<{ x: number; y: number }>({ x: 24, y: 76 });
  const [pipSize, setPipSize] = useState<{ w: number; h: number }>({ w: 420, h: 320 });
  const isDraggingPiP = useRef(false);
  const isResizingPiP = useRef(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number }>({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; startW: number; startH: number }>({ mouseX: 0, mouseY: 0, startW: 0, startH: 0 });

  // Chat Drawer
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Settings Modal
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [geminiModel, setGeminiModel] = useState('gemini-3.5-flash-lite');
  const [customApiKey, setCustomApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // Voice Engine State
  const [voiceActive, setVoiceActive] = useState(voiceEngine.isEnabled());

  // Load history & settings from localStorage on mount
  useEffect(() => {
    try {
      const savedHist = localStorage.getItem('terralab_research_history');
      if (savedHist) setHistory(JSON.parse(savedHist));
      const savedModel = localStorage.getItem('terralab_gemini_model');
      if (savedModel && (savedModel.includes('3.5') || savedModel.includes('2.5'))) {
        setGeminiModel(savedModel);
      } else {
        setGeminiModel('gemini-3.5-flash-lite');
        localStorage.setItem('terralab_gemini_model', 'gemini-3.5-flash-lite');
      }
      const savedKey = localStorage.getItem('terralab_gemini_custom_key');
      if (savedKey) setCustomApiKey(savedKey);
    } catch {
      // ignore
    }
  }, []);

  // Save history to localStorage
  const saveHistoryItem = (data: ResearchFieldData) => {
    const updated: HistoryItem[] = [
      { timestamp: new Date().toLocaleString(), data },
      ...history.slice(0, 9),
    ];
    setHistory(updated);
    try {
      localStorage.setItem('terralab_research_history', JSON.stringify(updated));
    } catch {
      // ignore
    }
  };

  // Weather Fetch via Open-Meteo
  const fetchWeather = useCallback(async (lat: number, lon: number, locationName: string) => {
    try {
      setWeatherOpen(true);
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code,visibility&timezone=auto`
      );
      const data = await res.json();
      if (data && data.current) {
        const c = data.current;
        setWeatherData({
          location: locationName,
          temp: Math.round(c.temperature_2m),
          feels: Math.round(c.apparent_temperature),
          humidity: c.relative_humidity_2m,
          wind: Math.round(c.wind_speed_10m),
          visibility: Math.round((c.visibility || 10000) / 1000),
          desc: WEATHER_CODES[c.weather_code] || 'Clear',
          lat,
          lon,
        });
      }
    } catch (err) {
      console.error('Weather fetch error:', err);
    }
  }, []);

  // Reverse Geocoding
  const reverseGeocode = async (lat: number, lon: number) => {
    try {
      const res = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
      );
      const data = await res.json();
      const name = data.locality || data.city || data.town || data.village || data.principalSubdivision || 'Selected Field';
      const state = data.principalSubdivision || '';
      return state && name !== state ? `${name}, ${state}` : name;
    } catch {
      return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    }
  };

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView([20.5937, 78.9629], 5);

    L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
      maxZoom: 21,
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const drawnGroup = new L.FeatureGroup();
    map.addLayer(drawnGroup);
    drawnItemsRef.current = drawnGroup;

    const optGroup = new L.FeatureGroup();
    map.addLayer(optGroup);
    opticalGroupRef.current = optGroup;

    mapRef.current = map;

    return () => {
      try {
        map.stop();
      } catch {
        // ignore
      }
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Handling Map Drawing Mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let tempRect: L.Rectangle | null = null;

    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (!isDrawing) return;
      map.dragging.disable();
      drawStartRef.current = e.latlng;
      tempRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
        color: '#10b981',
        weight: 2,
        fillColor: '#10b981',
        fillOpacity: 0.15,
        dashArray: '4, 4',
      });
      map.addLayer(tempRect);
    };

    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (!isDrawing || !drawStartRef.current || !tempRect) return;
      tempRect.setBounds(L.latLngBounds(drawStartRef.current, e.latlng));
    };

    const onMouseUp = (e: L.LeafletMouseEvent) => {
      if (!isDrawing || !drawStartRef.current) return;
      map.dragging.enable();
      setIsDrawing(false);

      const bounds = L.latLngBounds(drawStartRef.current, e.latlng);
      drawStartRef.current = null;

      if (tempRect) {
        map.removeLayer(tempRect);
        tempRect = null;
      }

      // Check minimum span
      if (Math.abs(bounds.getNorth() - bounds.getSouth()) < 0.0005) {
        return;
      }

      applyDrawnBounds(bounds);
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
    };
  }, [isDrawing]);

  // Apply Drawn Area & Add Vertex Markers
  const applyDrawnBounds = (bounds: L.LatLngBounds) => {
    const map = mapRef.current;
    const group = drawnItemsRef.current;
    if (!map || !group) return;

    group.clearLayers();
    opticalGroupRef.current?.clearLayers();
    setOpticalCvData(null);

    const rect = L.rectangle(bounds, {
      color: '#10b981',
      weight: 2,
      fillColor: '#10b981',
      fillOpacity: 0.18,
    });
    group.addLayer(rect);

    const center = bounds.getCenter();
    setSelectedBounds(bounds);
    setSelectedCenter(center);

    // Calculate approximate area
    const nw = bounds.getNorthWest();
    const se = bounds.getSouthEast();
    const dLat = Math.abs(nw.lat - se.lat) * 111.32;
    const dLon = Math.abs(nw.lng - se.lng) * 111.32 * Math.cos((center.lat * Math.PI) / 180);
    const areaSqKm = (dLat * dLon).toFixed(2);
    const areaHa = Math.round(dLat * dLon * 100);

    // Add Vertex Pins
    const corners = [
      { name: 'P1', pos: bounds.getNorthWest() },
      { name: 'P2', pos: bounds.getNorthEast() },
      { name: 'P3', pos: bounds.getSouthEast() },
      { name: 'P4', pos: bounds.getSouthWest() },
    ];

    corners.forEach((c) => {
      const pin = L.circleMarker(c.pos, {
        radius: 4,
        color: '#10b981',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2,
      });
      pin.bindTooltip(
        `<strong style="color:#10b981;">${c.name}</strong> • ${c.pos.lat.toFixed(4)}, ${c.pos.lng.toFixed(4)}`,
        { direction: 'top', className: 'research-map-tooltip' }
      );
      group.addLayer(pin);
    });

    rect.bindTooltip(
      `<div style="font-family:monospace; font-size:11px;">
        <div style="font-weight:bold; color:#34d399; margin-bottom:2px;">FIELD BOUNDS</div>
        <div>Area: <strong>${areaSqKm} km²</strong> (${areaHa} ha)</div>
        <div>Center: ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}</div>
      </div>`,
      { direction: 'center', permanent: false, className: 'research-map-tooltip' }
    );

    // Trigger Weather fetch for center
    reverseGeocode(center.lat, center.lng).then((name) => {
      fetchWeather(center.lat, center.lng, name);
    });
  };

  // Optical Satellite Computer Vision Feature Extraction (NDWI water, ExG canopy, solar, building)
  const handleScanOpticalCv = async () => {
    if (!selectedBounds) return;
    setOpticalCvLoading(true);
    try {
      const sw = selectedBounds.getSouthWest();
      const ne = selectedBounds.getNorthEast();
      const farmBbox: BoundingBox = {
        south: sw.lat,
        west: sw.lng,
        north: ne.lat,
        east: ne.lng,
      };

      const res = await detectObjects(farmBbox, ['tree', 'water', 'building', 'solar'], 'hybrid');
      setOpticalCvData(res);
      setOpticalCvVisible(true);

      const group = opticalGroupRef.current;
      if (group) {
        group.clearLayers();
        res.detections.forEach((d) => {
          let color = '#10b981'; // canopy
          let label = 'Vegetation Canopy';
          if (d.type === 'water') {
            color = '#38bdf8';
            label = 'Hydrology / Surface Water';
          } else if (d.type === 'building') {
            color = '#f59e0b';
            label = 'Agricultural Structure';
          } else if (d.type === 'solar') {
            color = '#c084fc';
            label = 'Solar Array';
          }

          const marker = L.circleMarker([d.lat, d.lon], {
            radius: d.type === 'building' ? 5 : 4,
            color,
            fillColor: color,
            fillOpacity: 0.7,
            weight: 1.5,
          });
          marker.bindTooltip(
            `<strong style="color:${color};">${label}</strong><br/><span style="font-size:10px; color:#94a3b8;">Conf: ${(d.confidence * 100).toFixed(0)}%</span>`,
            { className: 'research-map-tooltip' }
          );
          group.addLayer(marker);
        });
      }
      setToastMsg(`Detected ${res.detections.length} optical features on field`);
      setTimeout(() => setToastMsg(null), 3000);
    } catch (err) {
      console.error('Optical CV scan error:', err);
      setToastMsg('Optical CV scan could not connect to satellite stream.');
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setOpticalCvLoading(false);
    }
  };

  // Autocomplete Location Search
  const handleSearchInput = async (val: string) => {
    setSearchQuery(val);
    if (val.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val)}&limit=5`,
        { headers: { 'User-Agent': 'DisasterLens-Research/2.0' } }
      );
      const list = await res.json();
      setSuggestions(list || []);
    } catch {
      setSuggestions([]);
    }
  };

  const handleSelectLocation = (s: { display_name: string; lat: string; lon: string }) => {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    setSearchQuery(s.display_name);
    setSuggestions([]);

    const map = mapRef.current;
    if (!map) return;

    map.setView([lat, lon], 14);

    // Auto-create a sample AOI box around the selected place
    const delta = 0.015;
    const bounds = L.latLngBounds([lat - delta, lon - delta], [lat + delta, lon + delta]);
    applyDrawnBounds(bounds);
  };

  // Perform Field Analysis via Gemini
  const handleAnalyze = async () => {
    if (!selectedCenter) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setSidebarOpen(true);
    setActiveTab('current');

    try {
      const locName = await reverseGeocode(selectedCenter.lat, selectedCenter.lng);
      const cvStats = opticalCvData?.stats;
      const totalDet = cvStats?.total || 0;
      const vegPct = cvStats?.vegetation_pct ?? (totalDet > 0 ? Math.round(((cvStats?.by_type?.tree || 0) / totalDet) * 100) : 0);
      const waterPct = cvStats?.water_pct ?? (totalDet > 0 ? Math.round(((cvStats?.by_type?.water || 0) / totalDet) * 100) : 0);
      const cvContext = opticalCvData
        ? {
            vegetation_pct: vegPct,
            water_pct: waterPct,
            structures_count: (cvStats?.by_type?.building || 0) + (cvStats?.by_type?.solar || 0),
          }
        : undefined;

      const res = await analyzeResearchField({
        lat: selectedCenter.lat,
        lon: selectedCenter.lng,
        location_name: locName,
        model: geminiModel,
        api_key: customApiKey || undefined,
        bbox: selectedBounds ? [selectedBounds.getSouth(), selectedBounds.getWest(), selectedBounds.getNorth(), selectedBounds.getEast()] : undefined,
        optical_cv_context: cvContext,
      });

      if (res.error) {
        setAnalysisError(res.error);
      } else {
        setReportData(res);
        saveHistoryItem(res);
        if (voiceEngine.isEnabled()) {
          voiceEngine.speak(res.location_insight || 'Field analysis complete.');
        }
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed. Please check your Gemini API configuration.');
    } finally {
      setAnalyzing(false);
    }
  };

  // Export Field Dossier to Clipboard
  const handleExportDossier = () => {
    if (!reportData) return;
    const text = `# TerraLab Horizon — Agronomic Field Dossier
Generated: ${new Date().toLocaleString()}
Target Field: ${reportData.location} (${reportData.lat?.toFixed(4)}, ${reportData.lng?.toFixed(4)})

## Insight
${reportData.location_insight}

## Regional & Climate Context
- Settlement: ${reportData.demographics?.population_type || 'N/A'}
- Primary Language: ${reportData.demographics?.language || 'N/A'}
- Seasonal Temp: ${reportData.climate?.temperature || 'N/A'}°C
- Climate Type: ${reportData.climate?.description || 'N/A'}
- Humidity: ${reportData.climate?.humidity || 'N/A'}%
- Sea Level Elevation: ${reportData.climate?.sea_level || 'N/A'}m

## Soil Chemistry & Fertility
- Classification: ${reportData.soil?.type || 'N/A'}
- pH Level: ${reportData.soil?.ph || 'N/A'}
- NPK: Nitrogen (${reportData.soil?.nitrogen || 'Opt'}), Phosphorus (${reportData.soil?.phosphorus || 'Med'}), Potassium (${reportData.soil?.potassium || 'Good'})
- Detected Soil Minerals: ${reportData.soil?.metals?.join(', ') || 'None'}

## Optimized Crop Matches
${reportData.crops?.map((c, i) => `${i + 1}. ${c.name} — ${c.match}% match (Season: ${c.season})`).join('\n') || 'N/A'}

## Irrigation & Preservation Strategy
- Water Requirement: ${reportData.water?.quantity || 'N/A'}
- Recommended Schedule: ${reportData.water?.schedule || 'N/A'}
- Agronomic Strategy: ${reportData.strategy}
`;
    try {
      navigator.clipboard.writeText(text);
      setToastMsg('Agronomic Field Dossier copied to clipboard');
      setTimeout(() => setToastMsg(null), 3000);
    } catch {
      setToastMsg('Dossier generated.');
      setTimeout(() => setToastMsg(null), 2000);
    }
  };

  // Discuss with AI Chat
  const handleSendChat = async () => {
    const q = chatInput.trim();
    if (!q || chatLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: q };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);

    try {
      const contextStr = reportData
        ? `Location: ${reportData.location} (${reportData.lat}, ${reportData.lng})\nInsight: ${reportData.location_insight}\nSoil: ${JSON.stringify(reportData.soil)}\nCrops: ${JSON.stringify(reportData.crops)}\nStrategy: ${reportData.strategy}`
        : selectedCenter
        ? `Coordinates: ${selectedCenter.lat.toFixed(4)}, ${selectedCenter.lng.toFixed(4)}`
        : 'General Agricultural Research';

      const res = await chatResearchField({
        question: q,
        context: contextStr,
        model: geminiModel,
        api_key: customApiKey || undefined,
      });

      const botMsg: ChatMessage = { role: 'assistant', content: res.answer };
      setChatMessages((prev) => [...prev, botMsg]);

      if (voiceEngine.isEnabled()) {
        voiceEngine.speak(res.answer);
      }
    } catch (err) {
      const errMsg: ChatMessage = {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Failed to connect to AI.'}`,
      };
      setChatMessages((prev) => [...prev, errMsg]);
    } finally {
      setChatLoading(false);
    }
  };

  // Street View PiP Mouse Drag / Resize Handlers
  const onPiPHeaderMouseDown = (e: React.MouseEvent) => {
    isDraggingPiP.current = true;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: pipPos.x,
      startY: pipPos.y,
    };
  };

  const onPiPResizeMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    isResizingPiP.current = true;
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: pipSize.w,
      startH: pipSize.h,
    };
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDraggingPiP.current) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        setPipPos({
          x: Math.max(10, dragStartRef.current.startX + dx),
          y: Math.max(10, dragStartRef.current.startY + dy),
        });
      } else if (isResizingPiP.current) {
        const dx = e.clientX - resizeStartRef.current.mouseX;
        const dy = e.clientY - resizeStartRef.current.mouseY;
        setPipSize({
          w: Math.max(260, Math.min(800, resizeStartRef.current.startW + dx)),
          h: Math.max(180, Math.min(600, resizeStartRef.current.startH + dy)),
        });
      }
    };

    const onMouseUp = () => {
      isDraggingPiP.current = false;
      isResizingPiP.current = false;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="research-page-root">
      {/* ─── Leaflet Full Map ────────────────────────────────────── */}
      <div ref={mapContainerRef} className="research-map-container" />

      {/* ─── Instant Floating Toast Notification ─────────────────── */}
      {toastMsg && (
        <div className="research-toast-banner">
          <IconCheck size={14} />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* ─── Top Floating Header Bar ────────────────────────────── */}
      <header className="research-header-bar">
        <div className="research-header-left">
          <button className="research-back-btn" onClick={onBack} title="Return to Dashboard">
            <span>← Dashboard</span>
          </button>
          <div className="research-brand-badge">
            <span className="research-brand-dot" />
            <span className="research-brand-title">TerraLab Horizon</span>
            <span className="research-brand-sub">AI Precision Agronomy &amp; Field Intelligence</span>
          </div>
        </div>

        <div className="research-header-actions">
          {!sidebarOpen && (
            <button className="research-hud-btn" onClick={() => setSidebarOpen(true)}>
              <span>Show Report</span>
            </button>
          )}

          <button
            className={`research-hud-btn ${isDrawing ? 'research-hud-btn--active' : ''}`}
            onClick={() => setIsDrawing((v) => !v)}
            title="Click and drag on the map to draw a custom field boundary"
          >
            <IconPencil size={14} />
            <span>{isDrawing ? 'Drawing Box…' : 'Draw Field'}</span>
          </button>

          {selectedBounds && (
            <>
              <button
                className={`research-hud-btn ${opticalCvData ? 'research-hud-btn--active' : ''}`}
                disabled={opticalCvLoading}
                onClick={handleScanOpticalCv}
                title="Extract vegetation canopy vigor (ExG) & water surface (NDWI) using Satellite Computer Vision"
              >
                <IconSatellite size={14} />
                <span>{opticalCvLoading ? 'Scanning CV…' : 'Optical CV'}</span>
              </button>

              <button
                className="research-hud-btn"
                onClick={() => {
                  drawnItemsRef.current?.clearLayers();
                  opticalGroupRef.current?.clearLayers();
                  setSelectedBounds(null);
                  setSelectedCenter(null);
                  setReportData(null);
                  setOpticalCvData(null);
                }}
              >
                <IconX size={14} />
                <span>Clear</span>
              </button>
            </>
          )}

          <button
            className="research-primary-btn"
            disabled={!selectedCenter || analyzing}
            onClick={handleAnalyze}
            title={!selectedCenter ? 'Draw an Area of Interest on the map first' : 'Analyze field with Gemini 3.5 Flash'}
          >
            <IconBolt size={14} />
            <span>{analyzing ? 'Scanning…' : 'Analyze Field'}</span>
          </button>
        </div>
      </header>

      {/* ─── Left Slide-Out Drawer (Report & History) ─────────────── */}
      <aside className={`research-sidebar ${sidebarOpen ? 'research-sidebar--open' : ''}`}>
        <div className="research-sidebar-header">
          <div className="research-sidebar-title-row">
            <div className="research-sidebar-title">
              <span className="research-icon-box">
                <IconSprout size={18} color="#38bdf8" />
              </span>
              <div>
                <h4>Field Intelligence</h4>
                <p>Gemini 3.5 Flash Agronomy</p>
              </div>
            </div>
            <div className="research-sidebar-controls">
              <button
                className={`research-icon-btn ${voiceActive ? 'research-icon-btn--active' : ''}`}
                onClick={() => setVoiceActive(voiceEngine.toggle())}
                title={voiceActive ? 'Mute AI Voice' : 'Enable AI Voice Narration'}
              >
                {voiceActive ? <IconVolume2 size={16} /> : <IconVolumeX size={16} />}
              </button>
              <button
                className="research-icon-btn"
                onClick={() => setSettingsOpen(true)}
                title="Gemini AI Settings"
              >
                <IconSettings size={16} />
              </button>
              <button
                className="research-icon-btn"
                onClick={() => setSidebarOpen(false)}
                title="Collapse Panel"
              >
                <IconX size={16} />
              </button>
            </div>
          </div>

          {/* Place Search Bar */}
          <div className="research-search-wrapper">
            <div className="research-search-icon-adornment">
              <IconSearch size={14} color="#64748b" />
            </div>
            <input
              type="text"
              className="research-search-input"
              placeholder="Search farm, city, or region…"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
            {suggestions.length > 0 && (
              <div className="research-autocomplete-list">
                {suggestions.map((s, idx) => (
                  <div
                    key={idx}
                    className="research-autocomplete-item"
                    onClick={() => handleSelectLocation(s)}
                  >
                    {s.display_name}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dual Tabs */}
          <div className="research-tabs-row">
            <button
              className={`research-tab-btn ${activeTab === 'current' ? 'research-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('current')}
            >
              Current Scan
            </button>
            <button
              className={`research-tab-btn ${activeTab === 'history' ? 'research-tab-btn--active' : ''}`}
              onClick={() => setActiveTab('history')}
            >
              History ({history.length})
            </button>
          </div>
        </div>

        {/* Scrollable Report Content */}
        <div className="research-sidebar-content">
          {activeTab === 'current' ? (
            analyzing ? (
              <div className="research-loading-state">
                <div className="research-spinner" />
                <p className="research-loading-title">Scanning Satellite Telemetry…</p>
                <p className="research-loading-sub">Synthesizing soil chemistry &amp; crop viability with Gemini 3.5 Flash</p>
              </div>
            ) : analysisError ? (
              <div className="research-error-box">
                <div className="research-error-icon">
                  <IconAlertTriangle size={24} color="#f87171" />
                </div>
                <h4>Analysis Notice</h4>
                <p>{analysisError}</p>
                <button
                  className="research-hud-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => setSettingsOpen(true)}
                >
                  Verify API Key
                </button>
              </div>
            ) : reportData ? (
              <div className="research-report-view">
                {/* Target Zone Card */}
                <div className="research-card">
                  <div className="research-card-eyebrow">TARGET ZONE</div>
                  <h3 className="research-location-name">{reportData.location}</h3>
                  <div className="research-coord-tag">
                    {reportData.lat?.toFixed(4)}, {reportData.lng?.toFixed(4)}
                  </div>
                  <p className="research-insight-quote">"{reportData.location_insight}"</p>
                  <div className="research-card-action-row">
                    {reportData.lat && reportData.lng && (
                      <button
                        className="research-streetview-btn"
                        onClick={() => {
                          setStreetViewCoords({ lat: reportData.lat!, lon: reportData.lng! });
                          setStreetViewOpen(true);
                        }}
                      >
                        <IconCamera size={13} />
                        <span>360° Street View</span>
                      </button>
                    )}
                    {onSendToSimulation && selectedBounds && (
                      <button
                        className="research-streetview-btn research-streetview-btn--primary"
                        onClick={() => {
                          const sw = selectedBounds.getSouthWest();
                          const ne = selectedBounds.getNorthEast();
                          onSendToSimulation(reportData.location || 'Selected Field', {
                            south: sw.lat,
                            west: sw.lng,
                            north: ne.lat,
                            east: ne.lng,
                          });
                        }}
                        title="Transfer this field into DisasterLens Dashboard to simulate Flood, Cyclone, or Heatwave impact"
                      >
                        <IconBolt size={13} />
                        <span>Simulate in Dashboard</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Optical Satellite Computer Vision Layer */}
                {opticalCvData && (
                  <div className="research-card research-card--highlight">
                    <div className="research-card-eyebrow" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <IconSatellite size={13} color="#38bdf8" />
                        <span>OPTICAL SATELLITE TELEMETRY (CV)</span>
                      </div>
                      <button
                        className="research-cv-toggle-btn"
                        onClick={() => {
                          const next = !opticalCvVisible;
                          setOpticalCvVisible(next);
                          if (opticalGroupRef.current && mapRef.current) {
                            if (next) mapRef.current.addLayer(opticalGroupRef.current);
                            else mapRef.current.removeLayer(opticalGroupRef.current);
                          }
                        }}
                      >
                        {opticalCvVisible ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                        <span>{opticalCvVisible ? 'Hide Markers' : 'Show Markers'}</span>
                      </button>
                    </div>
                    <div className="research-grid-2">
                      <div className="research-metric-tile">
                        <span className="research-metric-label">Canopy / Vigor (ExG)</span>
                        <span className="research-metric-val text-emerald">
                          {opticalCvData.stats?.vegetation_pct != null
                            ? `${opticalCvData.stats.vegetation_pct}%`
                            : opticalCvData.stats?.total
                            ? `${Math.round(((opticalCvData.stats.by_type?.tree || 0) / opticalCvData.stats.total) * 100)}%`
                            : 'Detected'}
                        </span>
                      </div>
                      <div className="research-metric-tile">
                        <span className="research-metric-label">Hydrology Index (NDWI)</span>
                        <span className="research-metric-val text-cyan">
                          {opticalCvData.stats?.water_pct != null
                            ? `${opticalCvData.stats.water_pct}%`
                            : opticalCvData.stats?.total
                            ? `${Math.round(((opticalCvData.stats.by_type?.water || 0) / opticalCvData.stats.total) * 100)}%`
                            : '0%'}
                        </span>
                      </div>
                    </div>
                    <div className="research-chip-wrap" style={{ marginTop: 4 }}>
                      <span className="research-metal-chip">
                        Structures: <strong>{(opticalCvData.stats?.by_type?.building || 0) + (opticalCvData.stats?.by_type?.solar || 0)}</strong>
                      </span>
                      <span className="research-metal-chip">
                        Canopies: <strong>{opticalCvData.stats?.by_type?.tree || 0}</strong>
                      </span>
                      <span className="research-metal-chip">
                        Engine: <strong>OpenCV Vector</strong>
                      </span>
                    </div>
                  </div>
                )}

                {/* Ag-Climate Hazard Resilience */}
                {reportData.hazard_resilience && (
                  <div className="research-card">
                    <div className="research-card-eyebrow">AG-CLIMATE HAZARD RESILIENCE</div>
                    <div className="research-resilience-score-row">
                      <div className="research-resilience-circle">
                        <span>{reportData.hazard_resilience.overall_score || 85}</span>
                        <small>/100</small>
                      </div>
                      <div className="research-resilience-summary">
                        <div className="research-metric-label">Resilience Baseline</div>
                        <div className="research-resilience-status">
                          {(reportData.hazard_resilience.overall_score || 85) >= 75 ? 'Optimal Stability' : 'Climate Exposed'}
                        </div>
                      </div>
                    </div>
                    <div className="research-grid-2" style={{ marginTop: 6 }}>
                      <div className="research-metric-tile">
                        <span className="research-metric-label">Flood Vulnerability</span>
                        <span className="research-metric-val">{reportData.hazard_resilience.flood_risk || 'Low'}</span>
                      </div>
                      <div className="research-metric-tile">
                        <span className="research-metric-label">Thermal / Drought</span>
                        <span className="research-metric-val">{reportData.hazard_resilience.drought_stress || 'Moderate'}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Regional Demographics & Climate */}
                {(reportData.demographics || reportData.climate) && (
                  <div className="research-card">
                    <div className="research-card-eyebrow">REGIONAL CONTEXT &amp; CLIMATE</div>
                    <div className="research-grid-2">
                      {reportData.demographics && (
                        <>
                          <div className="research-metric-tile">
                            <span className="research-metric-label">Settlement</span>
                            <span className="research-metric-val">{reportData.demographics.population_type}</span>
                          </div>
                          <div className="research-metric-tile">
                            <span className="research-metric-label">Language</span>
                            <span className="research-metric-val">{reportData.demographics.language}</span>
                          </div>
                        </>
                      )}
                      {reportData.climate && (
                        <>
                          <div className="research-metric-tile">
                            <span className="research-metric-label">Temperature</span>
                            <span className="research-metric-val text-cyan">{reportData.climate.temperature}°C</span>
                          </div>
                          <div className="research-metric-tile">
                            <span className="research-metric-label">Climate Pattern</span>
                            <span className="research-metric-val">{reportData.climate.description}</span>
                          </div>
                          <div className="research-metric-tile">
                            <span className="research-metric-label">Humidity</span>
                            <span className="research-metric-val">{reportData.climate.humidity}%</span>
                          </div>
                          {reportData.climate.sea_level && (
                            <div className="research-metric-tile">
                              <span className="research-metric-label">Elevation</span>
                              <span className="research-metric-val text-emerald">{reportData.climate.sea_level}m</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Soil Composition */}
                {reportData.soil && (
                  <div className="research-card">
                    <div className="research-card-eyebrow">SOIL PROFILE &amp; CHEMISTRY</div>
                    <div className="research-grid-2">
                      <div className="research-metric-tile">
                        <span className="research-metric-label">Classification</span>
                        <span className="research-metric-val">{reportData.soil.type}</span>
                      </div>
                      <div className="research-metric-tile">
                        <span className="research-metric-label">pH Gauge</span>
                        <div className="research-ph-row">
                          <span className="research-metric-val text-emerald">{reportData.soil.ph}</span>
                          <div className="research-ph-bar-track">
                            <div
                              className="research-ph-bar-fill"
                              style={{ width: `${Math.min(100, (parseFloat(reportData.soil.ph) / 14) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* NPK Status */}
                    <div className="research-npk-row">
                      <div className="research-npk-item">
                        <span className="research-npk-sub">Nitrogen</span>
                        <strong>{reportData.soil.nitrogen || 'Opt'}</strong>
                      </div>
                      <div className="research-npk-item">
                        <span className="research-npk-sub">Phosphorus</span>
                        <strong>{reportData.soil.phosphorus || 'Med'}</strong>
                      </div>
                      <div className="research-npk-item">
                        <span className="research-npk-sub">Potassium</span>
                        <strong>{reportData.soil.potassium || 'Good'}</strong>
                      </div>
                    </div>

                    {/* Metals */}
                    {reportData.soil.metals && reportData.soil.metals.length > 0 && (
                      <div className="research-metals-section">
                        <span className="research-metric-label">Detected Soil Minerals</span>
                        <div className="research-chip-wrap">
                          {reportData.soil.metals.map((m, idx) => (
                            <span key={idx} className="research-metal-chip">
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Optimized Crops */}
                {reportData.crops && reportData.crops.length > 0 && (
                  <div className="research-card">
                    <div className="research-card-eyebrow">OPTIMIZED CROP RECOMMENDATIONS</div>
                    <div className="research-crops-list">
                      {reportData.crops.map((c, idx) => (
                        <div key={idx} className="research-crop-row">
                          <div className="research-crop-rank">{idx + 1}</div>
                          <div className="research-crop-info">
                            <div className="research-crop-name">{c.name}</div>
                            <div className="research-crop-season">{c.season}</div>
                          </div>
                          <div className="research-crop-match">
                            <span className="research-match-pct">{c.match}%</span>
                            <div className="research-match-bar">
                              <div className="research-match-fill" style={{ width: `${c.match}%` }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Irrigation & Strategic Guidance */}
                {reportData.strategy && (
                  <div className="research-card research-card--highlight">
                    <div className="research-card-eyebrow">IRRIGATION &amp; STRATEGIC GUIDANCE</div>
                    {reportData.water && (
                      <div className="research-water-summary">
                        <span>Water Req: {reportData.water.quantity}</span>
                        <span className="research-water-schedule">{reportData.water.schedule}</span>
                      </div>
                    )}
                    <p className="research-strategy-body">"{reportData.strategy}"</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="research-empty-state">
                <div className="research-empty-radar">
                  <div className="research-radar-ring" />
                  <span className="research-radar-icon">
                    <IconSatellite size={28} color="#38bdf8" />
                  </span>
                </div>
                <h4>Awaiting Field Target</h4>
                <p>Click "Draw Field" to box any farm or area of interest to initiate precision agronomic telemetry.</p>
              </div>
            )
          ) : (
            /* History Tab */
            <div className="research-history-list">
              {history.length === 0 ? (
                <div className="research-empty-history">No scan history yet.</div>
              ) : (
                history.map((h, idx) => (
                  <div
                    key={idx}
                    className="research-history-item"
                    onClick={() => {
                      setReportData(h.data);
                      setActiveTab('current');
                      if (h.data.lat && h.data.lng && mapRef.current) {
                        mapRef.current.setView([h.data.lat, h.data.lng], 13);
                      }
                    }}
                  >
                    <div className="research-history-top">
                      <span className="research-history-date">{h.timestamp}</span>
                      <span className="research-history-place">{h.data.location?.split(',')[0]}</span>
                    </div>
                    <div className="research-history-crop">
                      <IconSprout size={13} color="#10b981" />
                      <span>Top Crop: <strong>{h.data.crops?.[0]?.name || 'N/A'}</strong> ({h.data.crops?.[0]?.match}%)</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="research-sidebar-footer">
          <button
            className="research-discuss-btn"
            onClick={() => setChatOpen(true)}
            title="Open grounded conversational research assistant"
          >
            <IconBot size={15} />
            <span>Discuss with AI Assistant</span>
          </button>
          {reportData && (
            <button
              className="research-dossier-btn"
              onClick={handleExportDossier}
              title="Copy complete agronomic report dossier to clipboard"
            >
              <IconCopy size={14} />
              <span>Export Field Dossier</span>
            </button>
          )}
        </div>
      </aside>

      {/* ─── Side-by-Side Floating Chat Window ──────────────────── */}
      {chatOpen && (
        <div className="research-chat-window">
          <div className="research-chat-header">
            <div className="research-chat-title">
              <span className="research-chat-badge">
                <IconSparkles size={16} color="#38bdf8" />
              </span>
              <div>
                <h5>Gemini Research Advisor</h5>
                <p>Grounded in Field Telemetry &amp; CV</p>
              </div>
            </div>
            <button className="research-chat-close" onClick={() => setChatOpen(false)}>
              <IconX size={15} />
            </button>
          </div>

          <div className="research-chat-messages">
            <div className="research-chat-msg research-chat-msg--assistant">
              Ask me anything regarding soil nutrients, crop rotation, climate suitability, or precision irrigation for this area.
            </div>
            {chatMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`research-chat-msg ${
                  msg.role === 'user' ? 'research-chat-msg--user' : 'research-chat-msg--assistant'
                }`}
              >
                {msg.content}
                {msg.role === 'assistant' && (
                  <button
                    className="research-msg-speak-btn"
                    onClick={() => voiceEngine.speak(msg.content, true)}
                    title="Read aloud"
                  >
                    <IconVolume2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {chatLoading && <div className="research-chat-typing">Gemini 3.5 Flash is reasoning…</div>}
          </div>

          <div className="research-chat-input-row">
            <input
              type="text"
              placeholder="Ask about crops, pH, irrigation..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
            />
            <button disabled={chatLoading || !chatInput.trim()} onClick={handleSendChat}>
              Send
            </button>
          </div>
        </div>
      )}

      {/* ─── Live Weather HUD Widget ────────────────────────────── */}
      {weatherOpen && weatherData && (
        <div className="research-weather-widget">
          <div className="research-weather-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconCloudSun size={15} color="#38bdf8" />
              <span>Live Meteorology</span>
            </div>
            <button onClick={() => setWeatherOpen(false)}>
              <IconX size={14} />
            </button>
          </div>
          <div className="research-weather-body">
            <div className="research-weather-main">
              <div>
                <p className="research-weather-loc">{weatherData.location}</p>
                <p className="research-weather-desc">{weatherData.desc}</p>
              </div>
              <div className="research-weather-temp">
                <span>{weatherData.temp}°C</span>
                <small>Feels {weatherData.feels}°C</small>
              </div>
            </div>
            <div className="research-weather-metrics">
              <div>
                <small>Humidity</small>
                <strong>{weatherData.humidity}%</strong>
              </div>
              <div>
                <small>Wind</small>
                <strong>{weatherData.wind} km/h</strong>
              </div>
              <div>
                <small>Visibility</small>
                <strong>{weatherData.visibility} km</strong>
              </div>
            </div>
            <button
              className="research-streetview-btn"
              style={{ marginTop: 8 }}
              onClick={() => {
                setStreetViewCoords({ lat: weatherData.lat, lon: weatherData.lon });
                setStreetViewOpen(true);
              }}
            >
              <IconCamera size={13} />
              <span>Street View</span>
            </button>
          </div>
        </div>
      )}

      {/* ─── Draggable & Resizable Street View PiP ───────────────── */}
      {streetViewOpen && streetViewCoords && (
        <div
          className="research-pip-window"
          style={{
            left: pipPos.x,
            top: pipPos.y,
            width: pipSize.w,
            height: pipSize.h,
          }}
        >
          <div className="research-pip-header" onMouseDown={onPiPHeaderMouseDown}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconCamera size={14} color="#38bdf8" />
              <span>Live 360° Street View ({streetViewCoords.lat.toFixed(4)}, {streetViewCoords.lon.toFixed(4)})</span>
            </div>
            <button onClick={() => setStreetViewOpen(false)}>
              <IconX size={14} />
            </button>
          </div>
          <div className="research-pip-body">
            <iframe
              title="Google Street View"
              src={`https://maps.google.com/maps?q=&layer=c&cbll=${streetViewCoords.lat},${streetViewCoords.lon}&cbp=11,0,0,0,0&output=svembed`}
              allowFullScreen
            />
            <div className="research-pip-resizer" onMouseDown={onPiPResizeMouseDown}>
              ⌟
            </div>
          </div>
        </div>
      )}

      {/* ─── Settings Modal ─────────────────────────────────────── */}
      {settingsOpen && (
        <div className="research-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="research-modal" onClick={(e) => e.stopPropagation()}>
            <div className="research-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconSettings size={16} color="#38bdf8" />
                <h3>AI Research Engine Settings</h3>
              </div>
              <button onClick={() => setSettingsOpen(false)}>
                <IconX size={16} />
              </button>
            </div>
            <div className="research-modal-body">
              <label>Gemini Model</label>
              <select
                value={geminiModel}
                onChange={(e) => {
                  setGeminiModel(e.target.value);
                  localStorage.setItem('terralab_gemini_model', e.target.value);
                }}
              >
                <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite (Default &amp; Recommended)</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
              </select>

              <label style={{ marginTop: 14 }}>
                Custom Google AI Studio Key <small>(Optional — server key used by default)</small>
              </label>
              <div className="research-key-input-row">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  placeholder="AIzaSy... (leave blank to use server key)"
                  value={customApiKey}
                  onChange={(e) => {
                    setCustomApiKey(e.target.value);
                    localStorage.setItem('terralab_gemini_custom_key', e.target.value);
                  }}
                />
                <button type="button" onClick={() => setShowApiKey((v) => !v)}>
                  {showApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <div className="research-modal-footer">
              <button className="research-primary-btn" onClick={() => setSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
