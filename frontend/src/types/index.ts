// DisasterLens — Complete TypeScript Definitions

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface SimulationRequest {
  bbox: BoundingBox;
  disaster_type: string;
  location_name: string;
  // Flood
  rainfall_mm?: number;
  duration_hours?: number;
  sea_level_surge_m?: number;
  // Earthquake
  magnitude?: number;
  depth_km?: number;
  // Wildfire
  wind_speed_kmh?: number;
  wind_direction_deg?: number;
  temperature_c?: number;
  relative_humidity_pct?: number;
  // Landslide
  cumulative_rainfall_mm?: number;
  // Cyclone
  central_pressure_hpa?: number;
  max_wind_kmh?: number;
}

export interface RoadFeature {
  id: number;
  name: string;
  type: string;
  coords: [number, number][];
  midpoint: { lat: number; lon: number };
  length_m: number;
  status: 'open' | 'restricted' | 'closed';
  flood_depth: number;
  hazard_severity?: number;
  closure_reason?: string;
  lanes?: string | number;
  maxspeed?: string;
  surface?: string;
  oneway?: string;
  bridge?: string;
  tunnel?: string;
  layer?: string;
  ref?: string;
  lit?: string;
  osm_type?: string;
  elevation_m?: number;
  min_elevation_m?: number;
  max_elevation_m?: number;
  slope_pct?: number;
  raw_tags?: Record<string, any>;
}

export interface BuildingFeature {
  id: number;
  name: string;
  type: string;
  centroid: { lat: number; lon: number };
  area_sqm: number;
  flooded: boolean;
  flood_depth: number;
  hazard_severity?: number;
  levels?: number;
  height_m?: number;
  elevation_m?: number;
  addr_street?: string;
  addr_postcode?: string;
  operator?: string;
  amenity?: string;
  osm_type?: string;
  raw_tags?: Record<string, any>;
}

export interface Facility {
  id: number;
  name: string;
  type: string;
  lat: number;
  lon: number;
  flooded: boolean;
  flood_depth: number;
  elevation_m?: number;
  distance_km?: number;
  capacity?: number;
  address?: string;
  district?: string;
  postcode?: string;
  phone?: string;
  email?: string;
  website?: string;
  operator?: string;
  operator_type?: string;
  emergency?: string;
  healthcare?: string;
  osm_type?: string;
  raw_tags?: Record<string, any>;
}

export interface EvacuationRoute {
  from_label: string;
  to_facility_name: string;
  to_facility_type: string;
  route_distance_km: number;
  straight_line_distance_km: number;
  estimated_travel_time_min: number;
  path_coordinates: [number, number][];
  road_segments_count: number;
  status: string;
}

export interface RoadStatus {
  open: number;
  restricted: number;
  closed: number;
  total: number;
  open_length_km: number;
  restricted_length_km: number;
  closed_length_km: number;
  total_length_km: number;
}

export interface EvacuationAction {
  priority: number;
  action: string;
  zone: string;
  reason: string;
}

export interface AIInsight {
  severity: string;
  summary: string;
  key_findings: string[];
  evacuation_actions: EvacuationAction[];
  warnings: string[];
  safe_routes_advice: string;
  data_citations?: string[];
  source: string;
}

export interface DataSource {
  id: string;
  name: string;
  provider: string;
  source_url: string;
  license: string;
  layer_types: string[];
  spatial_resolution: string;
  temporal_coverage: string;
  acquisition_method: string;
  confidence: string;
  status: string;
}

export interface DisasterModelProvenance {
  model_name: string;
  type: string;
  version: string;
  governing_equations: string;
  assumptions: string[];
  uncertainty: string;
  units: Record<string, string>;
  output_resolution: string;
}

export interface ProvenanceResponse {
  data_sources: DataSource[];
  disaster_model: DisasterModelProvenance;
  generated_at: string;
  disclaimer: string;
}

export interface SimulationResult {
  run_uuid: string;
  simulation: {
    timesteps: number[];
    frames: number[][][];
    max_depth: number[][];
    max_hazard: number[][];
    rows: number;
    cols: number;
    total_time_hours: number;
    disaster_type: string;
    hazard_unit: string;
    model_name: string;
  };
  impact: {
    disaster_type: string;
    flooded_area_km2: number;
    affected_area_km2: number;
    avg_flood_depth_m: number;
    peak_flood_depth_m: number;
    peak_hazard_value: number;
    hazard_unit: string;
    estimated_population_exposed: number;
    buildings_affected: number;
    total_buildings: number;
    road_status: RoadStatus;
    critical_facilities_at_risk: number;
    facilities: Facility[];
    safe_facilities: Facility[];
    evacuation_routes: EvacuationRoute[];
    aoi_flooded_area_km2?: number;
    outside_flooded_area_km2?: number;
    discharged_outside_m3?: number;
    outflow_pct?: number;
  };
  geodata: {
    roads: RoadFeature[];
    buildings?: BuildingFeature[];
    facilities?: Facility[];
    hospitals?: Facility[];
    shelters?: Facility[];
    stats: Record<string, number>;
  };
  evacuation_routes: EvacuationRoute[];
  ai_insight: AIInsight;
  elevation: {
    rows: number;
    cols: number;
    min_elevation: number;
    max_elevation: number;
    grid?: number[][];
    resolution_m?: number;
    dataset?: string;
    vertical_datum?: string;
    accuracy_m?: string;
  };
  bbox: BoundingBox;
  aoi_bbox?: BoundingBox;
  timing: Record<string, number>;
  scenario: Record<string, any>;
  provenance: ProvenanceResponse;
}

export type DisasterType = 'flood' | 'cyclone' | 'earthquake' | 'landslide' | 'wildfire';

export interface ScenarioPreset {
  id: string;
  name: string;
  disaster_type: DisasterType;
  location_name: string;
  bbox: BoundingBox;
  parameters: Record<string, any>;
  description: string;
}
