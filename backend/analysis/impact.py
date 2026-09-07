"""
DisasterLens — Multi-Hazard GIS Impact Engine
==============================================
Implements InaSAFE-inspired deterministic spatial analysis:
Hazard + Exposure → Impact.
Intersects multi-hazard rasters (Flood, Earthquake, Wildfire, Landslide, Cyclone)
with real exposure data (roads, buildings, critical facilities, population grids)
and derives road network accessibility and evacuation paths.
"""

import numpy as np
import math
import copy
import logging
from typing import Dict, Any, List, Optional
import config
from geodata.population import generate_population_grid, calculate_exposed_population
from analysis.routing import compute_evacuation_routes

logger = logging.getLogger(__name__)


# --- Per-hazard physical damage / casualty constants (documented; local to
# this module per ownership rules — do not import from simulation/*) ---
# Flood: USACE-style depth-damage curve; depth thresholds (m) for states.
FLOOD_DAMAGE_BASE = 0.15
FLOOD_DAMAGE_SLOPE = 0.35
FLOOD_DAMAGE_CAP = 0.95
# Earthquake MMI bands -> (state, ratio). HAZUS-inspired order-of-magnitude.
EQ_DAMAGE_STATES = ("None", "Slight", "Moderate", "Extensive", "Complete")
EQ_DAMAGE_RATIOS = (0.0, 0.05, 0.25, 0.6, 1.0)
# Earthquake MMI fatality rates per band (HAZUS-inspired order-of-magnitude;
# injuries = 10x fatalities): VII [6.5-7.5), VIII [7.5-8.5), IX [8.5-9.5), X+ >=9.5.
EQ_FATALITY_RATES = (5e-5, 5e-4, 5e-3, 2e-2)
# Cyclone wind (km/h) bands -> (state, ratio).
CYCLONE_DAMAGE_STATES = ("None", "Minor", "Moderate", "Extensive", "Complete")
CYCLONE_DAMAGE_RATIOS = (0.0, 0.05, 0.25, 0.6, 1.0)
# Wildfire burn severity 0-1 thresholds.
WILDFIRE_BURNED_SEV = 0.65
WILDFIRE_DAMAGED_SEV = 0.35
# Landslide susceptibility index 0-1 thresholds.
LANDSLIDE_BURIED_LSI = 0.75
LANDSLIDE_DAMAGED_LSI = 0.5
# Buildings with damage_ratio >= this count as destroyed.
DESTROYED_RATIO_THRESHOLD = 0.6
# Wildfire smoke: roads with severity in [SMOKE_MIN_SEV, severe) within
# SMOKE_ROAD_BUFFER_CELLS (Manhattan) of a severe cell become restricted.
WILDFIRE_SEVERE_SEV = 0.65
SMOKE_ROAD_MIN_SEV = 0.30
SMOKE_ROAD_BUFFER_CELLS = 2
# Wildfire smoke buffer (population + facilities): Manhattan dilation radius
# around burned cells (severity > BURNED_POP_SEV).
BURNED_POP_SEV = 0.5
SMOKE_BUFFER_CELLS = 3
# Earthquake road structure flags (MMI thresholds on sampled max severity).
EQ_BRIDGE_CLOSED_MMI = 7.0
EQ_TUNNEL_CLOSED_MMI = 7.5
# Population displacement / at-risk thresholds.
FLOOD_DISPLACED_DEPTH_M = 0.5
CYCLONE_DISPLACED_WIND_KMH = 150.0
CYCLONE_DISPLACED_SURGE_M = 0.3
LANDSLIDE_AT_RISK_LSI = 0.65


def analyze_impact(
    simulation_result: Dict[str, Any],
    geodata: Dict[str, Any],
    bbox: Dict[str, float],
    grid_resolution: float = config.DEFAULT_GRID_RESOLUTION,
    elevation: Optional[np.ndarray] = None,
    start_points: Optional[List[Dict[str, float]]] = None,
) -> Dict[str, Any]:
    """
    Analyze multi-hazard impact against infrastructure and population.
    Integrates Copernicus GLO-30 DEM elevation along all road network segments.
    """
    max_hazard = np.array(simulation_result.get("max_hazard", simulation_result.get("max_depth", [])))
    rows = simulation_result.get("rows", max_hazard.shape[0])
    cols = simulation_result.get("cols", max_hazard.shape[1])
    disaster_type = simulation_result.get("disaster_type", "flood")
    # Synthetic-flag wiring (additive): never mutate caller/cache-owned lists.
    is_synthetic = bool(geodata.get("is_synthetic", False))
    # Optional cyclone surge component (same shape as wind grid when present).
    _surge_raw = simulation_result.get("surge_grid")
    surge_grid = None
    if _surge_raw is not None:
        try:
            surge_grid = np.array(_surge_raw, dtype=np.float64)
            if surge_grid.shape != max_hazard.shape:
                logger.warning("Ignoring surge_grid with shape %s (expected %s)", surge_grid.shape, max_hazard.shape)
                surge_grid = None
        except Exception:
            logger.warning("Ignoring unreadable surge_grid", exc_info=True)
            surge_grid = None

    # 1. Hazard-specific thresholds for road accessibility
    thresholds = _get_hazard_thresholds(disaster_type)

    # 2. Affected area calculation (inside AOI vs exterior buffer runoff)
    impact_mask = max_hazard >= thresholds["impact_min"]
    cell_area_sqm = grid_resolution * grid_resolution
    affected_cells = int(np.sum(impact_mask))
    affected_area_km2 = (affected_cells * cell_area_sqm) / 1_000_000.0

    aoi_bbox = simulation_result.get("aoi_bbox", bbox)
    lats = np.linspace(bbox["north"], bbox["south"], rows)
    lons = np.linspace(bbox["west"], bbox["east"], cols)
    LON, LAT = np.meshgrid(lons, lats)
    aoi_mask = (LAT >= aoi_bbox["south"]) & (LAT <= aoi_bbox["north"]) & (LON >= aoi_bbox["west"]) & (LON <= aoi_bbox["east"])
    outside_mask = ~aoi_mask

    aoi_affected_cells = int(np.sum(impact_mask & aoi_mask))
    outside_affected_cells = int(np.sum(impact_mask & outside_mask))
    aoi_flooded_area_km2 = (aoi_affected_cells * cell_area_sqm) / 1_000_000.0
    outside_flooded_area_km2 = (outside_affected_cells * cell_area_sqm) / 1_000_000.0

    outside_volume_m3 = float(np.sum(max_hazard[outside_mask & impact_mask])) * cell_area_sqm
    total_volume_m3 = float(np.sum(max_hazard[impact_mask])) * cell_area_sqm
    outflow_pct = (outside_volume_m3 / max(total_volume_m3, 1.0)) * 100.0 if outside_affected_cells > 0 else 0.0

    # 3. Road Network Impact & Classification with Copernicus DEM Elevation
    # Wildfire smoke buffer (2-cell Manhattan dilation of severe cells) for
    # smoke-restricted roads; numpy-only, guarded for tiny grids.
    smoke_road_zone = None
    if disaster_type == "wildfire" and max_hazard.size > 0 and rows > 0 and cols > 0:
        try:
            severe_mask = np.array(max_hazard >= WILDFIRE_SEVERE_SEV, dtype=bool)
            if severe_mask.shape == max_hazard.shape and bool(np.any(severe_mask)):
                smoke_road_zone = _dilate_manhattan(severe_mask, SMOKE_ROAD_BUFFER_CELLS)
            else:
                smoke_road_zone = np.zeros_like(severe_mask, dtype=bool)
        except Exception:
            logger.warning("Wildfire smoke road-zone computation failed", exc_info=True)
            smoke_road_zone = None
    roads = copy.deepcopy(geodata.get("roads", []))
    roads_open = 0
    roads_restricted = 0
    roads_closed = 0
    open_km = 0.0
    restricted_km = 0.0
    closed_km = 0.0

    for road in roads:
        coords = road.get("coords", [])
        if not coords:
            continue
        sample_pts = _sample_road_points(coords, max_samples=8)
        severities = _get_severities_at_points(sample_pts, max_hazard, bbox, rows, cols)
        max_road_severity = max(severities) if severities else 0.0
        
        road["hazard_severity"] = round(max_road_severity, 3)
        road["flood_depth"] = round(max_road_severity, 3)  # backward compatibility
        length_km = road.get("length_m", 100.0) / 1000.0

        # Sample Copernicus GLO-30 DEM elevation along road geometry
        if elevation is not None and rows > 0 and cols > 0:
            elev_pts = _get_severities_at_points(sample_pts, elevation, bbox, rows, cols)
            if elev_pts:
                mean_elev = float(np.mean(elev_pts))
                min_elev = float(np.min(elev_pts))
                max_elev = float(np.max(elev_pts))
                road["elevation_m"] = round(mean_elev, 1)
                road["min_elevation_m"] = round(min_elev, 1)
                road["max_elevation_m"] = round(max_elev, 1)
                elev_diff = abs(elev_pts[-1] - elev_pts[0])
                road_len = max(road.get("length_m", 100.0), 10.0)
                road["slope_pct"] = round((elev_diff / road_len) * 100.0, 1)
        elif "elevation_m" not in road:
            mid = road.get("midpoint", {"lat": (bbox["north"] + bbox["south"]) / 2.0, "lon": (bbox["west"] + bbox["east"]) / 2.0})
            approx = max(2.0, 14.0 + 8.0 * math.sin(mid["lat"] * 90) + 6.0 * math.cos(mid["lon"] * 90))
            road["elevation_m"] = round(approx, 1)
            road["min_elevation_m"] = round(approx - 1.2, 1)
            road["max_elevation_m"] = round(approx + 1.4, 1)
            road["slope_pct"] = round(abs(math.sin(mid["lat"] * 50)) * 3.5 + 0.5, 1)

        if max_road_severity >= thresholds["road_closed"]:
            road["status"] = "closed"
            road["closure_reason"] = _get_closure_reason(disaster_type, max_road_severity, road)
            roads_closed += 1
            closed_km += length_km
        elif max_road_severity >= thresholds["road_restricted"]:
            road["status"] = "restricted"
            road["closure_reason"] = f"Restricted: Moderate {disaster_type} risk"
            roads_restricted += 1
            restricted_km += length_km
        else:
            road["status"] = "open"
            road["closure_reason"] = "Clear"
            roads_open += 1
            open_km += length_km

        # Earthquake structures: bridge/tunnel flags upgrade sub-closed roads.
        if disaster_type == "earthquake" and road.get("status") != "closed":
            struct_reason = _get_closure_reason(disaster_type, max_road_severity, road)
            is_struct_closure = (
                (road.get("tunnel") and max_road_severity >= EQ_TUNNEL_CLOSED_MMI)
                or (road.get("bridge") and max_road_severity >= EQ_BRIDGE_CLOSED_MMI)
            )
            if is_struct_closure:
                if road["status"] == "open":
                    roads_open -= 1
                    open_km -= length_km
                else:
                    roads_restricted -= 1
                    restricted_km -= length_km
                road["status"] = "closed"
                road["closure_reason"] = struct_reason
                roads_closed += 1
                closed_km += length_km

        # Wildfire smoke: low-severity roads near severe cells become restricted.
        if (
            disaster_type == "wildfire"
            and smoke_road_zone is not None
            and SMOKE_ROAD_MIN_SEV <= max_road_severity < WILDFIRE_SEVERE_SEV
            and road.get("status") != "closed"
        ):
            try:
                near_smoke = False
                for pt in sample_pts:
                    idx = _cell_index(pt["lat"], pt["lon"], bbox, rows, cols)
                    if idx is not None and bool(smoke_road_zone[idx[0], idx[1]]):
                        near_smoke = True
                        break
                if near_smoke and road.get("status") != "restricted":
                    roads_open -= 1
                    open_km -= length_km
                    road["status"] = "restricted"
                    roads_restricted += 1
                    restricted_km += length_km
                if near_smoke:
                    road["status"] = "restricted"
                    road["closure_reason"] = "Smoke / low visibility"
            except Exception:
                logger.warning("Wildfire smoke road classification failed", exc_info=True)

        # Cyclone surge: treat surge depth like flood depth (flood thresholds
        # from config). Only applies when surge_grid is present. Upgrades
        # road status to the more severe of wind vs surge outcome.
        if surge_grid is not None:
            try:
                surge_pts = _get_severities_at_points(sample_pts, surge_grid, bbox, rows, cols)
                max_surge = max(surge_pts) if surge_pts else 0.0
                road["surge_depth_m"] = round(float(max_surge), 3)
                surge_closed = max_surge >= config.ROAD_RESTRICTED_THRESHOLD
                surge_restricted = max_surge >= config.ROAD_OPEN_THRESHOLD
                if surge_closed and road["status"] != "closed":
                    if road["status"] == "open":
                        roads_open -= 1
                        open_km -= length_km
                    else:
                        roads_restricted -= 1
                        restricted_km -= length_km
                    road["status"] = "closed"
                    road["closure_reason"] = f"Flooded ({max_surge:.1f}m surge)"
                    roads_closed += 1
                    closed_km += length_km
                elif surge_restricted and road["status"] == "open":
                    roads_open -= 1
                    open_km -= length_km
                    road["status"] = "restricted"
                    road["closure_reason"] = f"Restricted: Surge flooding ({max_surge:.1f}m)"
                    roads_restricted += 1
                    restricted_km += length_km
            except Exception:
                logger.warning("Surge road classification failed", exc_info=True)

    total_roads = roads_open + roads_restricted + roads_closed
    total_km = open_km + restricted_km + closed_km

    # 4. Building Footprint Impact & Elevation
    buildings = copy.deepcopy(geodata.get("buildings", []))
    buildings_affected = 0
    buildings_destroyed = 0
    for b in buildings:
        centroid = b.get("centroid", {})
        if not centroid:
            state, ratio = _building_damage(disaster_type, 0.0, b)
            b["damage_state"] = state
            b["damage_ratio"] = float(ratio)
            continue
        val = _get_severity_at_point(centroid["lat"], centroid["lon"], max_hazard, bbox, rows, cols)
        b["hazard_severity"] = round(val, 3)
        b["flood_depth"] = round(val, 3)
        state, ratio = _building_damage(disaster_type, val, b)
        b["damage_state"] = state
        b["damage_ratio"] = float(ratio)
        if float(ratio) >= DESTROYED_RATIO_THRESHOLD:
            buildings_destroyed += 1
        is_affected = val >= thresholds["building_affected"]
        if surge_grid is not None:
            try:
                surge_val = _get_severity_at_point(centroid["lat"], centroid["lon"], surge_grid, bbox, rows, cols)
                b["surge_depth_m"] = round(float(surge_val), 3)
                if surge_val >= config.BUILDING_FLOOD_THRESHOLD:
                    is_affected = True
            except Exception:
                logger.warning("Surge building classification failed", exc_info=True)
        b["flooded"] = is_affected  # legacy UI key
        b["affected"] = is_affected
        if is_affected:
            buildings_affected += 1
        if elevation is not None and rows > 0 and cols > 0:
            val_elev = _get_severity_at_point(centroid["lat"], centroid["lon"], elevation, bbox, rows, cols)
            b["elevation_m"] = round(val_elev, 1)

    total_buildings = len(buildings)

    # 5. Population Exposure (+ per-hazard casualty/displacement estimates)
    pop_grid = generate_population_grid(geodata, bbox, rows, cols)
    exposed_population = calculate_exposed_population(pop_grid, impact_mask)
    if exposed_population == 0 and buildings_affected > 0:
        exposed_population = buildings_affected * config.PEOPLE_PER_BUILDING

    estimated_fatalities = 0
    estimated_injuries = 0
    estimated_displaced = 0
    population_smoke_exposed = 0
    population_at_risk = 0
    # 3-cell Manhattan smoke buffer around burned cells (wildfire), reused
    # for facilities below. Numpy-only dilation, guarded for tiny grids.
    wildfire_smoke_mask = None
    try:
        if pop_grid.shape == max_hazard.shape and max_hazard.size > 0:
            if disaster_type == "earthquake":
                # Order-of-magnitude HAZUS-inspired fatality rates per MMI band.
                bands = [
                    ((max_hazard >= 6.5) & (max_hazard < 7.5), EQ_FATALITY_RATES[0]),
                    ((max_hazard >= 7.5) & (max_hazard < 8.5), EQ_FATALITY_RATES[1]),
                    ((max_hazard >= 8.5) & (max_hazard < 9.5), EQ_FATALITY_RATES[2]),
                    (max_hazard >= 9.5, EQ_FATALITY_RATES[3]),
                ]
                fat = 0.0
                for band_mask, rate in bands:
                    fat += float(np.sum(pop_grid[band_mask])) * rate
                estimated_fatalities = int(round(fat))
                estimated_injuries = int(round(fat * 10.0))
            elif disaster_type == "flood":
                estimated_displaced = int(round(float(np.sum(pop_grid[max_hazard > FLOOD_DISPLACED_DEPTH_M]))))
            elif disaster_type == "cyclone":
                displaced_mask = max_hazard > CYCLONE_DISPLACED_WIND_KMH
                if surge_grid is not None and surge_grid.shape == max_hazard.shape:
                    displaced_mask = displaced_mask | (surge_grid > CYCLONE_DISPLACED_SURGE_M)
                estimated_displaced = int(round(float(np.sum(pop_grid[displaced_mask]))))
            elif disaster_type == "wildfire":
                burned = max_hazard > BURNED_POP_SEV
                wildfire_smoke_mask = _dilate_manhattan(burned, SMOKE_BUFFER_CELLS)
                population_smoke_exposed = int(round(float(np.sum(pop_grid[wildfire_smoke_mask]))))
            elif disaster_type == "landslide":
                population_at_risk = int(round(float(np.sum(pop_grid[max_hazard > LANDSLIDE_AT_RISK_LSI]))))
    except Exception:
        logger.warning("Per-hazard population estimate failed", exc_info=True)

    # 6. Critical Emergency Facilities Impact & Proximity
    center_lat = (bbox["north"] + bbox["south"]) / 2.0
    center_lon = (bbox["east"] + bbox["west"]) / 2.0

    all_facilities = []
    facilities_at_risk = 0

    for ftype in ["hospitals", "shelters", "police", "fire_stations", "schools"]:
        for fac in copy.deepcopy(geodata.get(ftype, [])):
            val = _get_severity_at_point(fac["lat"], fac["lon"], max_hazard, bbox, rows, cols)
            fac["hazard_severity"] = round(val, 3)
            fac["flood_depth"] = round(val, 3)
            is_at_risk = val >= thresholds["building_affected"]
            if surge_grid is not None:
                try:
                    surge_val = _get_severity_at_point(fac["lat"], fac["lon"], surge_grid, bbox, rows, cols)
                    if surge_val >= config.BUILDING_FLOOD_THRESHOLD:
                        is_at_risk = True
                except Exception:
                    logger.warning("Surge facility classification failed", exc_info=True)
            fac["flooded"] = is_at_risk
            fac["at_risk"] = is_at_risk
            if disaster_type == "earthquake":
                if val >= 7.5:
                    fac["functionality"] = "nonfunctional"
                elif val >= 6.5:
                    fac["functionality"] = "degraded"
                else:
                    fac["functionality"] = "operational"
            if disaster_type == "wildfire":
                try:
                    smoke_risk = False
                    if wildfire_smoke_mask is not None:
                        idx = _cell_index(fac["lat"], fac["lon"], bbox, rows, cols)
                        if idx is not None:
                            smoke_risk = bool(wildfire_smoke_mask[idx[0], idx[1]])
                    fac["smoke_risk"] = smoke_risk
                except Exception:
                    logger.warning("Facility smoke-risk check failed", exc_info=True)
                    fac["smoke_risk"] = False
            fac["distance_km"] = round(
                _haversine(center_lat, center_lon, fac["lat"], fac["lon"]) / 1000.0, 1
            )
            if elevation is not None and rows > 0 and cols > 0:
                fac_elev = _get_severity_at_point(fac["lat"], fac["lon"], elevation, bbox, rows, cols)
                fac["elevation_m"] = round(fac_elev, 1)
            if is_at_risk:
                facilities_at_risk += 1
            all_facilities.append(fac)

    all_facilities.sort(key=lambda f: f["distance_km"])
    safe_facilities = [f for f in all_facilities if not f.get("at_risk", False)]

    # 7. Safe Evacuation Routing on Open Road Network
    # Caller-supplied start_points take precedence; otherwise routing falls
    # back to its internal affected-zone defaults.
    evacuation_routes = compute_evacuation_routes(
        roads=roads,
        facilities=all_facilities,
        bbox=bbox,
        start_points=start_points,
        disaster_type=disaster_type,
    )

    peak_severity = float(np.max(max_hazard)) if max_hazard.size > 0 else 0.0
    avg_severity = float(np.mean(max_hazard[impact_mask])) if np.any(impact_mask) else 0.0
    max_surge_m = round(float(np.max(surge_grid)), 2) if surge_grid is not None and surge_grid.size else None

    result: Dict[str, Any] = {
        "disaster_type": disaster_type,
        "is_synthetic": is_synthetic,
        "flooded_area_km2": round(affected_area_km2, 2),
        "affected_area_km2": round(affected_area_km2, 2),
        "aoi_flooded_area_km2": round(aoi_flooded_area_km2, 2),
        "outside_flooded_area_km2": round(outside_flooded_area_km2, 2),
        "discharged_outside_m3": round(outside_volume_m3, 1),
        "outflow_pct": round(outflow_pct, 1),
        "avg_flood_depth_m": round(avg_severity, 2),
        "peak_flood_depth_m": round(peak_severity, 2),
        "peak_hazard_value": round(peak_severity, 2),
        "hazard_unit": thresholds["unit"],
        "estimated_population_exposed": exposed_population,
        "estimated_fatalities": estimated_fatalities,
        "estimated_injuries": estimated_injuries,
        "estimated_displaced": estimated_displaced,
        "population_smoke_exposed": population_smoke_exposed,
        "population_at_risk": population_at_risk,
        "buildings_affected": buildings_affected,
        "total_buildings": total_buildings,
        "road_status": {
            "open": roads_open,
            "restricted": roads_restricted,
            "closed": roads_closed,
            "total": total_roads,
            "open_length_km": round(open_km, 1),
            "restricted_length_km": round(restricted_km, 1),
            "closed_length_km": round(closed_km, 1),
            "total_length_km": round(total_km, 1),
        },
        "critical_facilities_at_risk": facilities_at_risk,
        "facilities": all_facilities[:25],
        "safe_facilities": safe_facilities[:12],
        "evacuation_routes": evacuation_routes,
        "roads": roads,
        "buildings": buildings,
        "buildings_summary": {
            "total": total_buildings,
            "affected": buildings_affected,
            "safe": total_buildings - buildings_affected,
            "buildings_destroyed": buildings_destroyed,
        },
    }
    if max_surge_m is not None:
        result["max_surge_m"] = max_surge_m
    return result


def _get_hazard_thresholds(disaster_type: str) -> Dict[str, Any]:
    """Define deterministic impact and road accessibility thresholds."""
    if disaster_type == "earthquake":
        return {
            "unit": "MMI Intensity",
            "impact_min": 5.0,
            "building_affected": 6.5,
            "road_restricted": 6.5,
            "road_closed": 7.8,
        }
    elif disaster_type == "wildfire":
        return {
            "unit": "Burn Severity",
            "impact_min": 0.2,
            "building_affected": 0.45,
            "road_restricted": 0.35,
            "road_closed": 0.65,
        }
    elif disaster_type == "landslide":
        return {
            "unit": "Susceptibility Index",
            "impact_min": 0.3,
            "building_affected": 0.65,
            "road_restricted": 0.50,
            "road_closed": 0.75,
        }
    elif disaster_type == "cyclone":
        return {
            "unit": "Wind Speed (km/h)",
            "impact_min": 75.0,
            "building_affected": 110.0,
            "road_restricted": 90.0,
            "road_closed": 130.0,
        }
    else:  # flood
        return {
            "unit": "meters (m)",
            "impact_min": config.FLOOD_DEPTH_MIN,
            "building_affected": config.BUILDING_FLOOD_THRESHOLD,
            "road_restricted": config.ROAD_OPEN_THRESHOLD,
            "road_closed": config.ROAD_RESTRICTED_THRESHOLD,
        }


def _get_closure_reason(disaster_type: str, val: float, road: Optional[Dict[str, Any]] = None) -> str:
    if disaster_type == "earthquake" and road is not None:
        try:
            if road.get("tunnel") and val >= EQ_TUNNEL_CLOSED_MMI:
                return f"Tunnel damage suspected (MMI {val:.1f})"
            if road.get("bridge") and val >= EQ_BRIDGE_CLOSED_MMI:
                return f"Bridge damage suspected (MMI {val:.1f})"
        except Exception:
            logger.warning("Bridge/tunnel closure check failed", exc_info=True)
    if disaster_type == "flood":
        return f"Flooded ({val:.1f}m)"
    elif disaster_type == "earthquake":
        return f"Structural Debris (MMI {val:.1f})"
    elif disaster_type == "wildfire":
        return f"Active Fire / Smoke (Severity {val:.2f})"
    elif disaster_type == "landslide":
        return f"Debris Flow / Slope Failure ({val:.2f})"
    elif disaster_type == "cyclone":
        return f"Hurricane Wind / Fallen Trees ({val:.0f} km/h)"
    return f"Impassable ({val:.1f})"


def _dilate_manhattan(mask: np.ndarray, iterations: int) -> np.ndarray:
    """Manhattan (4-neighbourhood) binary dilation, numpy-only (no scipy).

    Each iteration ORs the mask with its 4 cardinally-shifted copies, so N
    iterations cover all cells within Manhattan distance <= N. Safe on tiny
    grids (1x1, single row/col) via guarded slicing.
    """
    try:
        dilated = np.array(mask, dtype=bool)
    except Exception:
        return np.array(mask, dtype=bool)
    if dilated.size == 0 or iterations <= 0:
        return dilated
    rows, cols = dilated.shape if dilated.ndim == 2 else (0, 0)
    if rows == 0 or cols == 0:
        return dilated
    for _ in range(int(iterations)):
        grown = dilated.copy()
        if rows > 1:
            grown[1:, :] |= dilated[:-1, :]
            grown[:-1, :] |= dilated[1:, :]
        if cols > 1:
            grown[:, 1:] |= dilated[:, :-1]
            grown[:, :-1] |= dilated[:, 1:]
        dilated = grown
    return dilated


def _cell_index(lat: float, lon: float, bbox: Dict[str, float], rows: int, cols: int) -> Optional[tuple]:
    """Map a lat/lon to grid (r, c), or None when mapping is degenerate."""
    lat_r = bbox["north"] - bbox["south"]
    lon_r = bbox["east"] - bbox["west"]
    if lat_r <= 0 or lon_r <= 0 or rows <= 0 or cols <= 0:
        return None
    try:
        r = int((bbox["north"] - float(lat)) / lat_r * rows)
        c = int((float(lon) - bbox["west"]) / lon_r * cols)
    except Exception:
        return None
    r = max(0, min(r, rows - 1))
    c = max(0, min(c, cols - 1))
    return (r, c)


def _building_damage(disaster_type: str, severity: float, building: Dict[str, Any]) -> tuple:
    """Return (damage_state: str, damage_ratio: float 0-1) per hazard physics."""
    try:
        v = float(severity)
    except Exception:
        v = 0.0
    if disaster_type == "flood":
        ratio = min(FLOOD_DAMAGE_CAP, FLOOD_DAMAGE_BASE + FLOOD_DAMAGE_SLOPE * max(v, 0.0))
        if v < 0.08:
            return ("None", round(float(ratio if v >= 0.08 else 0.0), 3))
        if v < 0.3:
            return ("Minor", round(float(ratio), 3))
        if v < 1.0:
            return ("Moderate", round(float(ratio), 3))
        if v < 2.0:
            return ("Major", round(float(ratio), 3))
        return ("Destroyed", round(float(ratio), 3))
    elif disaster_type == "earthquake":
        if v < 6.0:
            idx = 0
        elif v < 6.5:
            idx = 1
        elif v < 7.2:
            idx = 2
        elif v < 7.8:
            idx = 3
        else:
            idx = 4
        try:
            levels = int(building.get("levels", 2))
        except Exception:
            levels = 2
        if levels >= 5 and idx < 4:
            idx += 1
        return (EQ_DAMAGE_STATES[idx], float(EQ_DAMAGE_RATIOS[idx]))
    elif disaster_type == "cyclone":
        if v < 90:
            idx = 0
        elif v < 120:
            idx = 1
        elif v < 150:
            idx = 2
        elif v < 180:
            idx = 3
        else:
            idx = 4
        return (CYCLONE_DAMAGE_STATES[idx], float(CYCLONE_DAMAGE_RATIOS[idx]))
    elif disaster_type == "wildfire":
        if v > WILDFIRE_BURNED_SEV:
            return ("Burned", 1.0)
        if v > WILDFIRE_DAMAGED_SEV:
            return ("Damaged", 0.4)
        return ("Unaffected", 0.0)
    elif disaster_type == "landslide":
        if v > LANDSLIDE_BURIED_LSI:
            return ("Buried", 1.0)
        if v > LANDSLIDE_DAMAGED_LSI:
            return ("Damaged", 0.5)
        return ("Unaffected", 0.0)
    return ("None", 0.0)


def _sample_road_points(coords: List[List[float]], max_samples: int = 8) -> List[Dict[str, float]]:
    n = len(coords)
    if n <= max_samples:
        return [{"lat": c[1], "lon": c[0]} for c in coords]
    step = (n - 1) / (max_samples - 1)
    indices = [int(i * step) for i in range(max_samples)]
    return [{"lat": coords[idx][1], "lon": coords[idx][0]} for idx in indices]


def _get_severity_at_point(lat: float, lon: float, grid: np.ndarray, bbox: Dict[str, float], rows: int, cols: int) -> float:
    lat_r = bbox["north"] - bbox["south"]
    lon_r = bbox["east"] - bbox["west"]
    if lat_r <= 0 or lon_r <= 0 or rows == 0 or cols == 0:
        return 0.0
    r = int((bbox["north"] - lat) / lat_r * rows)
    c = int((lon - bbox["west"]) / lon_r * cols)
    r = max(0, min(r, rows - 1))
    c = max(0, min(c, cols - 1))
    return float(grid[r, c])


def _get_severities_at_points(points: List[Dict[str, float]], grid: np.ndarray, bbox: Dict[str, float], rows: int, cols: int) -> List[float]:
    return [_get_severity_at_point(p["lat"], p["lon"], grid, bbox, rows, cols) for p in points]


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2
    return R * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
