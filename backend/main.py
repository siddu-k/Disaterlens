"""
DisasterLens — FastAPI Backend Service
=======================================
Orchestrates multi-hazard simulation engines, deterministic GIS impact analysis,
topological road network routing, spatial persistence, and grounded AI insights.
"""

import sys
import os
import uuid
import time
import hashlib
import threading
import logging
from typing import Optional, List, Dict, Any, Literal
import numpy as np

logger = logging.getLogger(__name__)

# Add backend directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

import config
from geodata.elevation import fetch_elevation_grid
from geodata.osm import fetch_geodata
from geodata.provenance import get_provenance_summary
from geodata.cached_scenarios import MUMBAI_GS_WARD_BBOX
from simulation.orchestrator import run_hazard_simulation, get_available_disasters
from analysis.impact import analyze_impact
from analysis.routing import compute_evacuation_routes
from ai.gemini import generate_insight, parse_natural_language_scenario
from db.spatial_store import record_simulation_run, get_simulation_run

app = FastAPI(
    title="DisasterLens API",
    description="Multi-hazard disaster simulation and impact-analysis platform",
    version="2.0.0",
)

# CORS for frontend dev server (explicit origins so credentials remain valid)
_FRONTEND_ORIGINS = [
    o.strip() for o in os.environ.get(
        "FRONTEND_ORIGINS", "http://localhost:5173,http://localhost:3000"
    ).split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class _SessionTTLCache:
    """Small bounded TTL cache for session scenario state."""

    def __init__(self, max_entries: int = 32, ttl_s: float = 30 * 60):
        self._store: Dict[str, Any] = {}
        self._expiry: Dict[str, float] = {}
        self._max = max_entries
        self._ttl = ttl_s
        self._lock = threading.Lock()

    def _purge_expired(self) -> None:
        now = time.time()
        for k in [k for k, exp in self._expiry.items() if exp <= now]:
            self._store.pop(k, None)
            self._expiry.pop(k, None)

    def __setitem__(self, key: str, value: Any) -> None:
        with self._lock:
            self._purge_expired()
            if key not in self._store and len(self._store) >= self._max:
                # Evict oldest entry
                oldest = min(self._expiry, key=lambda k: self._expiry[k])
                self._store.pop(oldest, None)
                self._expiry.pop(oldest, None)
            self._store[key] = value
            self._expiry[key] = time.time() + self._ttl

    def __getitem__(self, key: str) -> Any:
        with self._lock:
            exp = self._expiry.get(key)
            if exp is None or exp <= time.time():
                self._store.pop(key, None)
                self._expiry.pop(key, None)
                raise KeyError(key)
            return self._store[key]

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self.__getitem__(key)
        except KeyError:
            return default

    def __contains__(self, key: str) -> bool:
        try:
            self.__getitem__(key)
            return True
        except KeyError:
            return False


session_cache = _SessionTTLCache(max_entries=32, ttl_s=30 * 60)


def _scenario_cache_key(bbox: Dict[str, float], disaster_type: str, params: Dict[str, Any]) -> str:
    parts = [
        f"{bbox.get('south')},{bbox.get('west')},{bbox.get('north')},{bbox.get('east')}",
        str(disaster_type),
    ]
    for k in sorted(params):
        v = params[k]
        if isinstance(v, (dict, list)):
            v = repr(v)
        parts.append(f"{k}={v}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


# ─── Pydantic Request Models ──────────────────────────────────────

class BoundingBox(BaseModel):
    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)

    @model_validator(mode="after")
    def _check_bbox(self):
        if not (self.south < self.north):
            raise ValueError("BoundingBox requires south < north")
        if not (self.west < self.east):
            raise ValueError("BoundingBox requires west < east")
        area = (self.north - self.south) * (self.east - self.west)
        if area > 4.0:
            raise ValueError(f"BoundingBox area {area:.2f} deg² exceeds 4.0 deg² limit")
        return self


class SimulationRequest(BaseModel):
    bbox: BoundingBox
    disaster_type: Literal["flood", "cyclone", "earthquake", "wildfire", "landslide"] = Field(default="flood", description="flood, earthquake, wildfire, landslide, cyclone")
    location_name: str = Field(default="Selected Area")
    start_points: Optional[List[Dict[str, float]]] = None
    # Flood parameters
    rainfall_mm: Optional[float] = Field(default=150.0, ge=0, le=2500)
    duration_hours: Optional[float] = Field(default=24.0, ge=0.25, le=168)
    sea_level_surge_m: Optional[float] = Field(default=0.0, ge=0, le=15)
    # Earthquake parameters
    magnitude: Optional[float] = Field(default=6.8, ge=4.0, le=9.5)
    depth_km: Optional[float] = Field(default=10.0, ge=1.0, le=700.0)
    # Wildfire parameters
    wind_speed_kmh: Optional[float] = Field(default=28.0, ge=0, le=250)
    wind_direction_deg: Optional[float] = Field(default=45.0, ge=0, le=360)
    temperature_c: Optional[float] = Field(default=34.0, ge=0, le=60)
    relative_humidity_pct: Optional[float] = Field(default=22.0, ge=1, le=100)
    # Landslide parameters
    cumulative_rainfall_mm: Optional[float] = Field(default=200.0, ge=0, le=2000)
    # Cyclone parameters
    central_pressure_hpa: Optional[float] = Field(default=950.0, ge=870, le=1010)
    max_wind_kmh: Optional[float] = Field(default=165.0, ge=50, le=320)


class GeodataRequest(BaseModel):
    bbox: BoundingBox


class NaturalLanguageScenarioRequest(BaseModel):
    prompt: str
    current_disaster: str = "flood"


class AIInsightRequest(BaseModel):
    scenario: Dict[str, Any]
    impact: Dict[str, Any]
    location_name: str = "Selected Area"


class EvacuationRouteRequest(BaseModel):
    bbox: BoundingBox
    start_points: Optional[List[Dict[str, float]]] = None


class CompareRequest(BaseModel):
    run_id_a: Optional[str] = None
    run_id_b: Optional[str] = None
    scenario_a: Optional[Dict[str, Any]] = None
    scenario_b: Optional[Dict[str, Any]] = None


# ─── API Endpoints ────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "DisasterLens API",
        "version": "2.0.0",
        "gemini_configured": bool(config.GEMINI_API_KEY),
        "supported_disasters": [d["type"] for d in get_available_disasters()],
    }


@app.get("/api/disasters")
async def list_disasters():
    """List available multi-hazard plugins and their scientific specifications."""
    return {"disasters": get_available_disasters()}


@app.get("/api/provenance")
async def get_provenance(disaster_type: str = "flood"):
    """Retrieve explicit data provenance and model specifications."""
    summary = get_provenance_summary(disaster_type)
    try:
        from geodata.provenance import SYNTHETIC_DATA_NOTICE as _notice
    except ImportError:
        _notice = (
            "Some inputs may be procedurally generated synthetic data when live "
            "feeds are unreachable; treat affected layers as indicative, not observed."
        )
    summary["synthetic_data_notice"] = _notice
    return summary


@app.get("/api/scenarios/presets")
async def get_preset_scenarios():
    """Return authoritative validation presets for offline judging and testing."""
    return {
        "presets": [
            {
                "id": "mumbai_monsoon",
                "name": "Mumbai 24h Extreme Monsoon & Coastal Surge",
                "disaster_type": "flood",
                "location_name": "G/S Ward, Mumbai, Maharashtra",
                "bbox": MUMBAI_GS_WARD_BBOX,
                "parameters": {"rainfall_mm": 150.0, "duration_hours": 24.0, "sea_level_surge_m": 2.5},
                "description": "Extreme monsoon event with tidal storm surge across coastal corridors.",
            },
            {
                "id": "sf_earthquake",
                "name": "San Francisco Bay Mw 6.9 Seismic Event",
                "disaster_type": "earthquake",
                "location_name": "San Francisco, California, USA",
                "bbox": {"south": 37.74, "west": -122.48, "north": 37.82, "east": -122.38},
                "parameters": {"magnitude": 6.9, "depth_km": 10.0},
                "description": "Shallow San Andreas fault slip generating severe PGA and liquefaction hazard across urban fill.",
            },
            {
                "id": "tokyo_cloudburst",
                "name": "Tokyo Kanto Basin Extreme Cloudburst",
                "disaster_type": "flood",
                "location_name": "Shibuya & Shinjuku, Tokyo, Japan",
                "bbox": {"south": 35.65, "west": 139.67, "north": 35.71, "east": 139.73},
                "parameters": {"rainfall_mm": 220.0, "duration_hours": 8.0, "sea_level_surge_m": 0.0},
                "description": "Intense localized cloudburst exceeding underground storm canal discharge capacities.",
            },
            {
                "id": "miami_cyclone",
                "name": "Miami Atlantic Category 4 Hurricane Landfall",
                "disaster_type": "cyclone",
                "location_name": "Biscayne Bay, Miami, Florida, USA",
                "bbox": {"south": 25.72, "west": -80.25, "north": 25.80, "east": -80.14},
                "parameters": {"central_pressure_hpa": 935.0, "max_wind_kmh": 195.0, "duration_hours": 24.0},
                "description": "Direct hurricane landfall with intense storm surge inundation across low-lying barrier islands.",
            },
            {
                "id": "western_ghats_landslide",
                "name": "Western Ghats High-Pore Monsoon Landslide",
                "disaster_type": "landslide",
                "location_name": "Western Ghats Escarpment, India",
                "bbox": {"south": 18.90, "west": 73.20, "north": 18.98, "east": 73.30},
                "parameters": {"cumulative_rainfall_mm": 280.0, "duration_hours": 36.0},
                "description": "Continuous precipitation driving destabilization on steep weathered terrace slopes.",
            },
        ]
    }


@app.post("/api/scenario/parse")
def parse_scenario(request: NaturalLanguageScenarioRequest):
    """Convert natural language query into strict validated simulation parameters."""
    try:
        result = parse_natural_language_scenario(request.prompt, request.current_disaster)
        return result
    except Exception as e:
        logger.exception("Scenario parse failed")
        raise HTTPException(status_code=500, detail=f"Scenario parse error: {str(e)}")


@app.post("/api/geodata")
def get_geodata_endpoint(request: GeodataRequest):
    """Fetch geospatial data (roads, buildings, facilities) from OSM or spatial cache."""
    try:
        t0 = time.time()
        data = fetch_geodata(
            request.bbox.south,
            request.bbox.west,
            request.bbox.north,
            request.bbox.east,
        )
        data["fetch_time_s"] = round(time.time() - t0, 2)
        session_cache["geodata"] = data
        session_cache["bbox"] = request.bbox.model_dump()
        return data
    except Exception as e:
        logger.exception("Geodata fetch failed")
        raise HTTPException(status_code=500, detail=f"Failed to fetch geodata: {str(e)}")


@app.post("/api/elevation")
def get_elevation_endpoint(request: GeodataRequest):
    """Fetch elevation grid, slope, and aspect."""
    try:
        t0 = time.time()
        result = fetch_elevation_grid(
            request.bbox.south,
            request.bbox.west,
            request.bbox.north,
            request.bbox.east,
        )
        result["fetch_time_s"] = round(time.time() - t0, 2)
        return {
            "rows": result["rows"],
            "cols": result["cols"],
            "resolution_m": result["resolution_m"],
            "elevation": result["elevation"].tolist(),
            "slope_deg": result.get("slope_deg", np.zeros_like(result["elevation"])).tolist(),
            "min_elevation": float(np.nanmin(result["elevation"])),
            "max_elevation": float(np.nanmax(result["elevation"])),
            "fetch_time_s": result["fetch_time_s"],
        }
    except Exception as e:
        logger.exception("Elevation fetch failed")
        raise HTTPException(status_code=500, detail=f"Failed to fetch elevation: {str(e)}")


@app.post("/api/simulate")
def run_simulation_endpoint(request: SimulationRequest):
    """
    Run full end-to-end multi-hazard simulation pipeline:
    1. Retrieve DEM & Topography
    2. Ingest OSM roads, buildings, facilities
    3. Run scientific hazard engine (Flood, Quake, Wildfire, Landslide, Cyclone)
    4. Deterministic GIS Impact Intersection (InaSAFE concept)
    5. NetworkX graph safe evacuation routing
    6. Grounded AI Insight Generation
    """
    try:
        total_t0 = time.time()
        timing: Dict[str, float] = {}
        aoi_bbox = request.bbox.model_dump()
        disaster_type = request.disaster_type.lower()

        # Compute extended hydrological domain (18% border buffer) so stormwater can
        # naturally flow downhill across the AOI boundary into adjacent lower valleys/coastlines
        lat_span = max(abs(aoi_bbox["north"] - aoi_bbox["south"]), 0.005)
        lon_span = max(abs(aoi_bbox["east"] - aoi_bbox["west"]), 0.005)
        buffer_ratio = 0.18
        buffer_lat = lat_span * buffer_ratio
        buffer_lon = lon_span * buffer_ratio
        sim_bbox = {
            "south": round(aoi_bbox["south"] - buffer_lat, 5),
            "north": round(aoi_bbox["north"] + buffer_lat, 5),
            "west": round(aoi_bbox["west"] - buffer_lon, 5),
            "east": round(aoi_bbox["east"] + buffer_lon, 5),
        }

        # Step 1: Elevation & Topography for Extended Hydrological Domain
        t0 = time.time()
        elev_result = fetch_elevation_grid(
            sim_bbox["south"],
            sim_bbox["west"],
            sim_bbox["north"],
            sim_bbox["east"],
        )
        elevation = elev_result["elevation"]
        timing["elevation_time_s"] = round(time.time() - t0, 2)

        # Step 2: Ingest OSM geodata
        t0 = time.time()
        geodata = fetch_geodata(
            sim_bbox["south"],
            sim_bbox["west"],
            sim_bbox["north"],
            sim_bbox["east"],
        )
        timing["geodata_time_s"] = round(time.time() - t0, 2)

        # Step 3: Run Disaster Model with AOI & Extended Domain Topography
        t0 = time.time()
        scenario_params = request.model_dump(exclude={"bbox", "location_name"})
        scenario_params["aoi_bbox"] = aoi_bbox
        scenario_params["sim_bbox"] = sim_bbox

        try:
            hazard_output = run_hazard_simulation(
                disaster_type=disaster_type,
                elevation=elevation,
                geodata=geodata,
                scenario=scenario_params,
                resolution_m=elev_result["resolution_m"],
                bbox=sim_bbox,
            )
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        timing["simulation_time_s"] = round(time.time() - t0, 2)

        # Step 4: Deterministic GIS Impact Analysis & Road Routing
        t0 = time.time()
        sim_dict = {
            "max_hazard": hazard_output.max_hazard,
            "rows": hazard_output.rows,
            "cols": hazard_output.cols,
            "disaster_type": disaster_type,
            "aoi_bbox": aoi_bbox,
        }
        try:
            _surge = (hazard_output.metadata or {}).get("surge_grid")
        except Exception:
            _surge = None
        if _surge is not None:
            sim_dict["surge_grid"] = _surge
        impact = analyze_impact(
            simulation_result=sim_dict,
            geodata=geodata,
            bbox=sim_bbox,
            grid_resolution=elev_result["resolution_m"],
            elevation=elevation,
            start_points=request.start_points,
        )
        timing["analysis_time_s"] = round(time.time() - t0, 2)

        # Step 5: Grounded AI Insight Generation
        t0 = time.time()
        ai_insight = generate_insight(
            scenario=scenario_params,
            impact=impact,
            location_name=request.location_name,
        )
        timing["ai_time_s"] = round(time.time() - t0, 2)

        total_elapsed = round(time.time() - total_t0, 2)
        timing["total_time_s"] = total_elapsed

        # Persist simulation run
        run_uuid = str(uuid.uuid4())
        record_simulation_run(
            run_uuid=run_uuid,
            disaster_type=disaster_type,
            location_name=request.location_name,
            scenario=scenario_params,
            impact=impact,
            timing=timing,
        )

        session_cache["last_run"] = last_entry = {
            "run_uuid": run_uuid,
            "hazard_output": hazard_output,
            "impact": impact,
            "geodata": geodata,
            "bbox": sim_bbox,
            "aoi_bbox": aoi_bbox,
        }
        # Bounded per-scenario key: sha1(bbox + disaster_type + sorted params)
        try:
            _ckey = _scenario_cache_key(aoi_bbox, disaster_type, scenario_params)
            session_cache[_ckey] = last_entry
        except Exception:
            logger.warning("Scenario cache-key store failed", exc_info=True)

        # Synthetic-flag wiring (additive): surface data quality to clients
        geo_synth = bool(geodata.get("is_synthetic", False))
        elev_synth = bool(elev_result.get("is_synthetic", False))
        if geo_synth and elev_synth:
            data_quality = "synthetic"
        elif geo_synth or elev_synth:
            data_quality = "mixed"
        else:
            data_quality = "observed"
        top_is_synthetic = bool(geo_synth or elev_synth or impact.get("is_synthetic", False))

        # User-facing fetch warnings (additive): tell clients WHY fallback data
        # is used so the UI can advise drawing a smaller area.
        warnings: List[str] = []
        if geo_synth:
            _parts = geodata.get("synthetic_parts") or []
            if _parts:
                warnings.append(
                    "Live map data partially failed (" + ", ".join(_parts) + " unavailable) — "
                    "this area contains too many objects to fetch. Draw a smaller area for full real data."
                )
            else:
                warnings.append(
                    "Live map data (OpenStreetMap) timed out — this area contains too many "
                    "objects to fetch. Please draw a smaller area and run again."
                )
        if elev_synth:
            warnings.append(
                "Elevation service was rate-limited or unreachable — using modeled terrain. "
                "A smaller area reduces load; you can also retry in a minute."
            )

        # Build response adhering strictly to frontend specifications
        # (additive-only: existing keys preserved, new keys appended)
        simulation_payload: Dict[str, Any] = {
            "timesteps": hazard_output.timesteps,
            "frames": hazard_output.frames,
            "max_depth": hazard_output.max_hazard,
            "max_hazard": hazard_output.max_hazard,
            "rows": hazard_output.rows,
            "cols": hazard_output.cols,
            "total_time_hours": hazard_output.total_time_hours,
            "disaster_type": disaster_type,
            "hazard_unit": hazard_output.hazard_unit,
            "model_name": hazard_output.model_name,
        }
        try:
            _meta = hazard_output.metadata or {}
            if _meta.get("surge_grid") is not None:
                simulation_payload["surge_grid"] = _meta.get("surge_grid")
            if _meta.get("max_surge_m") is not None:
                simulation_payload["max_surge_m"] = _meta.get("max_surge_m")
        except Exception:
            logger.warning("Surge payload attach failed", exc_info=True)
        return {
            "run_uuid": run_uuid,
            "is_synthetic": top_is_synthetic,
            "data_quality": data_quality,
            "warnings": warnings,
            "simulation": simulation_payload,
            "impact": impact,
            "geodata": {
                "roads": impact.get("roads", geodata.get("roads", [])),
                "buildings": impact.get("buildings", geodata.get("buildings", [])),
                "facilities": geodata.get("facilities", []),
                "hospitals": geodata.get("hospitals", []),
                "shelters": geodata.get("shelters", []),
                "stats": geodata.get("stats", {}),
            },
            "evacuation_routes": impact.get("evacuation_routes", []),
            "ai_insight": ai_insight,
            "elevation": {
                "rows": elev_result["rows"],
                "cols": elev_result["cols"],
                "min_elevation": float(np.nanmin(elevation)),
                "max_elevation": float(np.nanmax(elevation)),
                "grid": elevation.tolist(),
                "resolution_m": elev_result.get("resolution_m", 30.0),
                "dataset": "Copernicus GLO-30 DEM",
                "vertical_datum": "EGM96 (Earth Gravitational Model 1996)",
                "accuracy_m": "< 4.0m LE90",
            },
            "bbox": sim_bbox,
            "aoi_bbox": aoi_bbox,
            "selected_bbox": aoi_bbox,
            "timing": timing,
            "scenario": scenario_params,
            "provenance": get_provenance_summary(disaster_type),
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("Simulation failed")
        raise HTTPException(status_code=500, detail=f"Simulation failed: {str(e)}")


@app.post("/api/evacuation-routes")
def get_evacuation_routes_endpoint(request: EvacuationRouteRequest):
    """Compute alternative safe evacuation routes on open road network."""
    try:
        bbox = request.bbox.model_dump()
        cached_bbox = None
        try:
            cached_bbox = session_cache.get("bbox")
        except Exception:
            cached_bbox = None
        if cached_bbox is not None and (
            round(cached_bbox.get("south", 0), 5) != round(bbox.get("south", 0), 5)
            or round(cached_bbox.get("west", 0), 5) != round(bbox.get("west", 0), 5)
            or round(cached_bbox.get("north", 0), 5) != round(bbox.get("north", 0), 5)
            or round(cached_bbox.get("east", 0), 5) != round(bbox.get("east", 0), 5)
        ):
            raise HTTPException(
                status_code=400,
                detail="Cached scenario is for a different area — run /api/simulate for this bbox first",
            )
        geodata = session_cache.get("geodata") or fetch_geodata(
            request.bbox.south, request.bbox.west, request.bbox.north, request.bbox.east
        )
        roads = geodata.get("roads", [])
        facilities = geodata.get("shelters", []) + geodata.get("hospitals", [])

        routes = compute_evacuation_routes(
            roads=roads,
            facilities=facilities,
            start_points=request.start_points,
            bbox=bbox,
        )
        return {"routes": routes}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Routing calculation failed")
        raise HTTPException(status_code=500, detail=f"Routing calculation failed: {str(e)}")


@app.post("/api/ai-insight")
def get_ai_insight_endpoint(request: AIInsightRequest):
    """Generate or refresh AI insight for simulation results."""
    try:
        insight = generate_insight(
            scenario=request.scenario,
            impact=request.impact,
            location_name=request.location_name,
        )
        return insight
    except Exception as e:
        logger.exception("AI insight failed")
        raise HTTPException(status_code=500, detail=f"AI insight failed: {str(e)}")


def _extract_impact(run_or_payload: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(run_or_payload, dict):
        return None
    if isinstance(run_or_payload.get("impact"), dict):
        return run_or_payload["impact"]
    # Accept a bare impact dict (inline scenario payload)
    numeric_probe = ("flooded_area_km2", "affected_area_km2", "estimated_population_exposed",
                     "buildings_affected", "road_status", "max_hazard", "peak_hazard_value")
    if any(k in run_or_payload for k in numeric_probe):
        return run_or_payload
    return None


@app.post("/api/compare")
def compare_simulations_endpoint(request: CompareRequest):
    """Compare two simulation runs or calculate metrics delta."""
    run_a = get_simulation_run(request.run_id_a) if request.run_id_a else None
    run_b = get_simulation_run(request.run_id_b) if request.run_id_b else None
    # Honor inline scenario payloads if provided (additive; run IDs take precedence)
    if run_a is None and request.scenario_a is not None:
        imp = _extract_impact(request.scenario_a)
        run_a = {"impact": imp, "scenario": request.scenario_a} if imp is not None else {"impact": {}, "scenario": request.scenario_a}
    if run_b is None and request.scenario_b is not None:
        imp = _extract_impact(request.scenario_b)
        run_b = {"impact": imp, "scenario": request.scenario_b} if imp is not None else {"impact": {}, "scenario": request.scenario_b}

    if not run_a or not run_b:
        # Fallback comparison demo data if run IDs are missing
        return {
            "comparison_summary": "Comparison requires two completed simulation run IDs.",
            "deltas": {},
        }

    imp_a = run_a.get("impact", {}) or {}
    imp_b = run_b.get("impact", {}) or {}

    delta_area = imp_b.get("flooded_area_km2", imp_b.get("affected_area_km2", 0)) - imp_a.get("flooded_area_km2", imp_a.get("affected_area_km2", 0))
    delta_pop = imp_b.get("estimated_population_exposed", 0) - imp_a.get("estimated_population_exposed", 0)
    delta_bld = imp_b.get("buildings_affected", 0) - imp_a.get("buildings_affected", 0)
    delta_roads_closed = (
        (imp_b.get("road_status", {}) or {}).get("closed", 0) - (imp_a.get("road_status", {}) or {}).get("closed", 0)
    )

    # Generic numeric deltas for whichever keys exist in both results
    generic_keys = [
        "flooded_area_km2", "affected_area_km2", "aoi_flooded_area_km2",
        "outside_flooded_area_km2", "affected_population", "estimated_population_exposed",
        "buildings_affected", "damaged_buildings", "closed_roads",
        "critical_facilities_at_risk", "max_hazard", "max_surge_m",
        "peak_hazard_value", "peak_flood_depth_m", "avg_flood_depth_m",
        "total_buildings",
    ]
    for k in list(imp_a.keys()):
        if k not in generic_keys and isinstance(imp_a.get(k), (int, float)) and isinstance(imp_b.get(k), (int, float)):
            generic_keys.append(k)
    deltas: Dict[str, Any] = {
        "affected_area_km2": round(delta_area, 2),
        "exposed_population": delta_pop,
        "buildings_affected": delta_bld,
        "roads_closed": delta_roads_closed,
    }
    for k in generic_keys:
        va, vb = imp_a.get(k), imp_b.get(k)
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)) and k not in deltas:
            try:
                deltas[k] = round(vb - va, 2) if isinstance(vb - va, float) else vb - va
            except Exception:
                continue
    # Nested road_status.closed delta under a generic alias too
    try:
        ra, rb = (imp_a.get("road_status", {}) or {}), (imp_b.get("road_status", {}) or {})
        if isinstance(ra.get("closed"), (int, float)) and isinstance(rb.get("closed"), (int, float)):
            deltas.setdefault("closed_roads", rb["closed"] - ra["closed"])
    except Exception:
        pass

    return {
        "run_a": run_a,
        "run_b": run_b,
        "deltas": deltas,
        "comparison_summary": (
            f"Scenario B vs A: Affected area changed by {delta_area:+.1f} km², "
            f"exposing {delta_pop:+d} additional residents, with {delta_roads_closed:+d} road closure changes."
        ),
        "summary": (
            f"Scenario B vs A: Affected area changed by {delta_area:+.1f} km², "
            f"exposing {delta_pop:+d} additional residents, with {delta_roads_closed:+d} road closure changes."
        ),
    }


if __name__ == "__main__":
    import uvicorn
    logger.info("\n[*] DisasterLens API Server Starting...")
    logger.info("    Gemini API: %s", '[OK] Configured' if config.GEMINI_API_KEY else '[!] Offline mode (deterministic rule-based insights)')
    logger.info("    Starting on http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)
