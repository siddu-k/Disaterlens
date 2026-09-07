"""
DisasterLens — Elevation Data Fetcher & Terrain Analysis
=========================================================
Fetches Digital Elevation Model (DEM) data from Open-Meteo / Copernicus
and derives terrain slope and aspect for hydrodynamic, landslide, and
wildfire propagation models.
"""

import numpy as np
import requests
import math
import logging
from typing import Dict, Any, Tuple
import config
from db.spatial_store import get_cached_elevation, save_cached_elevation

logger = logging.getLogger(__name__)


def fetch_elevation_grid(
    south: float,
    west: float,
    north: float,
    east: float,
    resolution_m: float = config.DEFAULT_GRID_RESOLUTION,
) -> Dict[str, Any]:
    """
    Fetch elevation data as a 2D grid for a bounding box with slope and aspect.
    Checks spatial cache first for instant response.
    """
    max_grid_size = 25
    center_lat = (south + north) / 2.0
    lat_span = max(abs(north - south), 0.001)
    lon_span = max(abs(east - west), 0.001)
    cos_lat = max(0.05, math.cos(math.radians(center_lat)))

    # Compute grid dimensions matching resolution, clamped to max_grid_size for 1-2s simulation speed
    raw_rows = max(10, int(lat_span / (resolution_m / 111320.0)))
    raw_cols = max(10, int(lon_span / (resolution_m / (111320.0 * cos_lat))))
    rows = min(max_grid_size, raw_rows)
    cols = min(max_grid_size, raw_cols)

    # 1. Check cache (resolution-aware so different resolutions don't collide)
    cached = get_cached_elevation(south, west, north, east, resolution_m=resolution_m, rows=rows, cols=cols)
    if cached is not None:
        elev = cached["elevation"]
        slope_deg, aspect_deg = calculate_slope_and_aspect(elev, cached["resolution_m"])
        cached["slope_deg"] = slope_deg
        cached["aspect_deg"] = aspect_deg
        if "is_synthetic" not in cached:
            cached["is_synthetic"] = False
        return cached

    lats = [round(float(v), 6) for v in np.linspace(north, south, rows)]
    lons = [round(float(v), 6) for v in np.linspace(west, east, cols)]

    all_points = [(lat_val, lon_val) for lat_val in lats for lon_val in lons]
    total_points = len(all_points)
    
    batch_size = 100
    all_elevations = []
    api_failed = False
    
    for i in range(0, total_points, batch_size):
        batch = all_points[i:i + batch_size]
        lat_str = ",".join([str(p[0]) for p in batch])
        lon_str = ",".join([str(p[1]) for p in batch])
        
        try:
            response = requests.get(
                config.ELEVATION_API_URL,
                params={"latitude": lat_str, "longitude": lon_str},
                timeout=3,
            )
            if response.status_code == 429:
                logger.warning(f"[Elevation] Open-Meteo 429 rate limit reached. Using synthetic terrain.")
                api_failed = True
                break
            response.raise_for_status()
            data = response.json()
            elevations = data.get("elevation", [])
            all_elevations.extend(elevations)
        except Exception as e:
            logger.warning(f"[Elevation] Notice: {e}. Falling back to deterministic terrain.")
            api_failed = True
            break

    if api_failed or len(all_elevations) != total_points:
        # Fallback terrain generation (deterministic gradient based on latitude/longitude)
        logger.info("[Elevation] Generating deterministic terrain from bounding coordinates")
        elevation_grid = _generate_synthetic_terrain(rows, cols, south, north, west, east)
        is_synthetic = True
    else:
        elevation_grid = np.array(all_elevations, dtype=np.float64).reshape(rows, cols)
        _fill_nan_neighbors(elevation_grid)
        is_synthetic = False

    slope_deg, aspect_deg = calculate_slope_and_aspect(elevation_grid, resolution_m)
    
    result = {
        "elevation": elevation_grid,
        "slope_deg": slope_deg,
        "aspect_deg": aspect_deg,
        "rows": rows,
        "cols": cols,
        "lats": lats,
        "lons": lons,
        "resolution_m": resolution_m,
        "is_synthetic": is_synthetic,
    }
    
    # Save to spatial cache
    try:
        save_cached_elevation(south, west, north, east, result)
    except Exception as e:
        logger.warning(f"[Elevation Cache] Warning: {e}")
        
    return result


def calculate_slope_and_aspect(elevation: np.ndarray, resolution_m: float) -> Tuple[np.ndarray, np.ndarray]:
    """Calculate terrain slope (degrees) and aspect (degrees azimuth from North)."""
    # dz/dy (north to south) and dz/dx (west to east)
    dy, dx = np.gradient(elevation, resolution_m, resolution_m)
    slope_rad = np.arctan(np.sqrt(dx**2 + dy**2))
    slope_deg = np.degrees(slope_rad)
    
    # Aspect: 0 is North, 90 is East, 180 is South, 270 is West
    aspect_rad = np.arctan2(-dx, dy)
    aspect_deg = (np.degrees(aspect_rad) + 360) % 360
    return slope_deg, aspect_deg


def _generate_synthetic_terrain(rows: int, cols: int, south: float, north: float, west: float, east: float) -> np.ndarray:
    """Generate realistic physical terrain when external API is unreachable."""
    y = np.linspace(0, 1, rows)
    x = np.linspace(0, 1, cols)
    X, Y = np.meshgrid(x, y)
    
    # Coastal ridge + gentle valley topography (e.g. 2m near coast to 45m on hills)
    base = 5.0 + 35.0 * np.sin(X * np.pi * 0.8) * np.cos(Y * np.pi * 0.6) + 10.0 * Y
    noise = 2.0 * np.sin(X * 10) * np.cos(Y * 10)
    grid = np.clip(base + noise, 0.5, 120.0)
    return grid


def _fill_nan_neighbors(grid: np.ndarray):
    """Fill NaN values with average of valid neighbors (in-place)."""
    rows, cols = grid.shape
    nan_mask = np.isnan(grid)
    if not np.any(nan_mask):
        return
    
    for _ in range(5):
        new_mask = np.isnan(grid)
        if not np.any(new_mask):
            break
        padded = np.pad(grid, 1, mode='edge')
        neighbor_sum = (
            padded[:-2, 1:-1] +
            padded[2:, 1:-1] +
            padded[1:-1, :-2] +
            padded[1:-1, 2:]
        )
        neighbor_count = (
            (~np.isnan(padded[:-2, 1:-1])).astype(float) +
            (~np.isnan(padded[2:, 1:-1])).astype(float) +
            (~np.isnan(padded[1:-1, :-2])).astype(float) +
            (~np.isnan(padded[1:-1, 2:])).astype(float)
        )
        fill_mask = new_mask & (neighbor_count > 0)
        grid[fill_mask] = neighbor_sum[fill_mask] / neighbor_count[fill_mask]
