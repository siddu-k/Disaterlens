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
from typing import Optional, List, Dict, Any
import numpy as np

# Add backend directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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

# CORS for frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

session_cache: Dict[str, Any] = {}


# ─── Pydantic Request Models ──────────────────────────────────────

class BoundingBox(BaseModel):
    south: float
    west: float
    north: float
    east: float


class SimulationRequest(BaseModel):
    bbox: BoundingBox
    disaster_type: str = Field(default="flood", description="flood, earthquake, wildfire, landslide, cyclone")
    location_name: str = Field(default="Selected Area")
    # Flood parameters
    rainfall_mm: Optional[float] = 150.0
    duration_hours: Optional[float] = 24.0
    sea_level_surge_m: Optional[float] = 0.0
    # Earthquake parameters
    magnitude: Optional[float] = 6.8
    depth_km: Optional[float] = 10.0
    # Wildfire parameters
    wind_speed_kmh: Optional[float] = 28.0
    wind_direction_deg: Optional[float] = 45.0
    temperature_c: Optional[float] = 34.0
    relative_humidity_pct: Optional[float] = 22.0
    # Landslide parameters
    cumulative_rainfall_mm: Optional[float] = 200.0
    # Cyclone parameters
    central_pressure_hpa: Optional[float] = 950.0
    max_wind_kmh: Optional[float] = 165.0


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
    return get_provenance_summary(disaster_type)


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
async def parse_scenario(request: NaturalLanguageScenarioRequest):
    """Convert natural language query into strict validated simulation parameters."""
    try:
        result = parse_natural_language_scenario(request.prompt, request.current_disaster)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scenario parse error: {str(e)}")


@app.post("/api/geodata")
async def get_geodata_endpoint(request: GeodataRequest):
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
        raise HTTPException(status_code=500, detail=f"Failed to fetch geodata: {str(e)}")


@app.post("/api/elevation")
async def get_elevation_endpoint(request: GeodataRequest):
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
        raise HTTPException(status_code=500, detail=f"Failed to fetch elevation: {str(e)}")


@app.post("/api/simulate")
async def run_simulation_endpoint(request: SimulationRequest):
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

        hazard_output = run_hazard_simulation(
            disaster_type=disaster_type,
            elevation=elevation,
            geodata=geodata,
            scenario=scenario_params,
            resolution_m=elev_result["resolution_m"],
            bbox=sim_bbox,
        )
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
        impact = analyze_impact(
            simulation_result=sim_dict,
            geodata=geodata,
            bbox=sim_bbox,
            grid_resolution=elev_result["resolution_m"],
            elevation=elevation,
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

        session_cache["last_run"] = {
            "run_uuid": run_uuid,
            "hazard_output": hazard_output,
            "impact": impact,
            "geodata": geodata,
            "bbox": sim_bbox,
            "aoi_bbox": aoi_bbox,
        }

        # Build response adhering strictly to frontend specifications
        return {
            "run_uuid": run_uuid,
            "simulation": {
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
            },
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

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Simulation failed: {str(e)}")


@app.post("/api/evacuation-routes")
async def get_evacuation_routes_endpoint(request: EvacuationRouteRequest):
    """Compute alternative safe evacuation routes on open road network."""
    try:
        bbox = request.bbox.model_dump()
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Routing calculation failed: {str(e)}")


@app.post("/api/ai-insight")
async def get_ai_insight_endpoint(request: AIInsightRequest):
    """Generate or refresh AI insight for simulation results."""
    try:
        insight = generate_insight(
            scenario=request.scenario,
            impact=request.impact,
            location_name=request.location_name,
        )
        return insight
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI insight failed: {str(e)}")


@app.post("/api/compare")
async def compare_simulations_endpoint(request: CompareRequest):
    """Compare two simulation runs or calculate metrics delta."""
    run_a = get_simulation_run(request.run_id_a) if request.run_id_a else None
    run_b = get_simulation_run(request.run_id_b) if request.run_id_b else None

    if not run_a or not run_b:
        # Fallback comparison demo data if run IDs are missing
        return {
            "comparison_summary": "Comparison requires two completed simulation run IDs.",
            "deltas": {},
        }

    imp_a = run_a["impact"]
    imp_b = run_b["impact"]

    delta_area = imp_b.get("flooded_area_km2", 0) - imp_a.get("flooded_area_km2", 0)
    delta_pop = imp_b.get("estimated_population_exposed", 0) - imp_a.get("estimated_population_exposed", 0)
    delta_bld = imp_b.get("buildings_affected", 0) - imp_a.get("buildings_affected", 0)
    delta_roads_closed = (
        imp_b.get("road_status", {}).get("closed", 0) - imp_a.get("road_status", {}).get("closed", 0)
    )

    return {
        "run_a": run_a,
        "run_b": run_b,
        "deltas": {
            "affected_area_km2": round(delta_area, 2),
            "exposed_population": delta_pop,
            "buildings_affected": delta_bld,
            "roads_closed": delta_roads_closed,
        },
        "summary": (
            f"Scenario B vs A: Affected area changed by {delta_area:+.1f} km², "
            f"exposing {delta_pop:+d} additional residents, with {delta_roads_closed:+d} road closure changes."
        ),
    }


if __name__ == "__main__":
    import uvicorn
    print("\n[*] DisasterLens API Server Starting...")
    print(f"    Gemini API: {'[OK] Configured' if config.GEMINI_API_KEY else '[!] Offline mode (deterministic rule-based insights)'}")
    print("    Starting on http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)
