// DisasterLens — API Service Layer

import { SimulationRequest, SimulationResult, ProvenanceResponse, ScenarioPreset } from '../types';

const API_BASE = 'http://localhost:8000/api';

export async function runSimulation(request: SimulationRequest): Promise<SimulationResult> {
  const response = await fetch(`${API_BASE}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Simulation request failed' }));
    throw new Error(error.detail || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function healthCheck(): Promise<{ status: string; gemini_configured: boolean; supported_disasters: string[] }> {
  const response = await fetch(`${API_BASE}/health`);
  return response.json();
}

export async function getPresets(): Promise<ScenarioPreset[]> {
  const response = await fetch(`${API_BASE}/scenarios/presets`);
  const data = await response.json();
  return data.presets || [];
}

export async function getProvenance(disasterType: string = 'flood'): Promise<ProvenanceResponse> {
  const response = await fetch(`${API_BASE}/provenance?disaster_type=${disasterType}`);
  return response.json();
}

export async function parseNaturalLanguageScenario(prompt: string, currentDisaster: string): Promise<any> {
  const response = await fetch(`${API_BASE}/scenario/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, current_disaster: currentDisaster }),
  });
  return response.json();
}

export async function compareSimulations(runIdA: string, runIdB: string): Promise<any> {
  const response = await fetch(`${API_BASE}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id_a: runIdA, run_id_b: runIdB }),
  });
  return response.json();
}

export async function geocodeLocation(query: string): Promise<{ name: string; bbox: { south: number; west: number; north: number; east: number }; lat: number; lon: number } | null> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
    const data = await res.json();
    if (data && data.length > 0) {
      const item = data[0];
      const bb = item.boundingbox;
      const centerLat = parseFloat(item.lat);
      const centerLon = parseFloat(item.lon);

      let south = Math.min(parseFloat(bb[0]), parseFloat(bb[1]));
      let north = Math.max(parseFloat(bb[0]), parseFloat(bb[1]));
      let west = Math.min(parseFloat(bb[2]), parseFloat(bb[3]));
      let east = Math.max(parseFloat(bb[2]), parseFloat(bb[3]));

      // If point or very tiny AOI, expand comfortably for neighborhood viewing
      if (north - south < 0.015) {
        south = centerLat - 0.018;
        north = centerLat + 0.018;
      }
      if (east - west < 0.015) {
        west = centerLon - 0.022;
        east = centerLon + 0.022;
      }

      // If overly large (e.g. state or country level query), frame at city level around center
      if (north - south > 0.25 || east - west > 0.25) {
        south = centerLat - 0.040;
        north = centerLat + 0.040;
        west = centerLon - 0.050;
        east = centerLon + 0.050;
      }

      const shortName = item.display_name.split(',').slice(0, 3).join(',').trim();

      return {
        name: shortName,
        bbox: { south, north, west, east },
        lat: centerLat,
        lon: centerLon,
      };
    }
  } catch (err) {
    console.error('Geocoding error:', err);
  }
  return null;
}

export async function reverseGeocodeLocation(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14`);
    const data = await res.json();
    if (data && data.display_name) {
      const parts = data.display_name.split(',');
      return parts.slice(0, 3).join(',').trim();
    }
  } catch (err) {
    console.warn('Reverse geocode error:', err);
  }
  return `Selected AOI (${lat.toFixed(3)}, ${lon.toFixed(3)})`;
}
