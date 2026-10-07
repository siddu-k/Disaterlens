"""
DisasterLens — Free unlimited DEM via AWS Terrain Tiles (Terrarium).
===============================================================
Primary elevation source. Terrarium PNG tiles encode 30m SRTM-class
elevation as: elev_m = R*256 + G + B/256 - 32768.
Free, no API key, CDN-backed — no per-point batching and no 429 rate
limits (the failure mode of point-query APIs like Open-Meteo).

Dataset: https://registry.opendata.aws/terrain-tiles/
Tiles:   s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png (z15 ≈ 30m)
"""

import io
import logging
import math
from typing import Dict, Any, Tuple

import numpy as np
import requests
from PIL import Image

import config

logger = logging.getLogger(__name__)

_TILE_PX = 256
_TILE_TIMEOUT_S = 10.0
_MAX_TILES_PER_AXIS = 8  # z15 AOIs are small; guard against bbox mixups


def lonlat_to_global_px(lat: float, lon: float, z: int) -> Tuple[float, float]:
    """WGS84 -> global pixel coords at zoom z (WebMercator)."""
    lat = max(-85.05112878, min(85.05112878, lat))
    n = 2.0 ** z
    xt = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    yt = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return xt * _TILE_PX, yt * _TILE_PX


def _decode_terrarium(img: Image.Image) -> np.ndarray:
    arr = np.asarray(img.convert("RGB"), dtype=np.float64)
    return arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0


def _fetch_tile(z: int, x: int, y: int) -> np.ndarray:
    url = config.TERRAIN_TILES_URL.format(z=z, x=x, y=y)
    resp = requests.get(url, timeout=_TILE_TIMEOUT_S)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content))
    return _decode_terrarium(img)


def fetch_terrarium_grid(
    south: float,
    west: float,
    north: float,
    east: float,
    rows: int,
    cols: int,
    zoom: int = None,
) -> Dict[str, Any]:
    """Sample real DEM elevations for an rows×cols lat/lon grid.

    Fetches only the z15 tiles covering the bbox, stitches them, and
    bilinearly samples each grid node. Raises on any failure so the
    caller can fall back to Open-Meteo, then synthetic terrain.
    Returns {"grid": np.ndarray, "source": str}.
    """
    z = zoom or config.TERRAIN_TILES_ZOOM
    # Global pixel bounds of the bbox (note: y grows southward)
    px_w, py_n = lonlat_to_global_px(north, west, z)
    px_e, py_s = lonlat_to_global_px(south, east, z)
    x0, x1 = int(math.floor(px_w / _TILE_PX)), int(math.floor(px_e / _TILE_PX))
    y0, y1 = int(math.floor(py_n / _TILE_PX)), int(math.floor(py_s / _TILE_PX))
    if (x1 - x0 + 1) > _MAX_TILES_PER_AXIS or (y1 - y0 + 1) > _MAX_TILES_PER_AXIS:
        raise ValueError(f"Terrarium tile span too large ({x1-x0+1}x{y1-y0+1})")
    W = (x1 - x0 + 1) * _TILE_PX
    H = (y1 - y0 + 1) * _TILE_PX
    mosaic = np.full((H, W), np.nan, dtype=np.float64)
    fetched = 0
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            try:
                tile = _fetch_tile(z, tx, ty)
            except Exception as e:
                # Open sea / void tiles 404 on S3 — leave NaN, neighbours fill in.
                logger.warning(f"[DEM-Tiles] tile z{z}/{tx}/{ty} unavailable ({e})")
                continue
            fetched += 1
            ox, oy = (tx - x0) * _TILE_PX, (ty - y0) * _TILE_PX
            mosaic[oy:oy + _TILE_PX, ox:ox + _TILE_PX] = tile
    if fetched == 0:
        raise ValueError("no Terrarium tiles fetchable for bbox")
    ox0, oy0 = x0 * _TILE_PX, y0 * _TILE_PX

    import numpy as _np
    lats = _np.linspace(north, south, rows)
    lons = _np.linspace(west, east, cols)
    grid = _np.empty((rows, cols), dtype=_np.float64)
    for r, lat in enumerate(lats):
        for c, lon in enumerate(lons):
            gx, gy = lonlat_to_global_px(float(lat), float(lon), z)
            fx, fy = gx - ox0, gy - oy0
            x = min(max(fx, 0.0), W - 1.001)
            y = min(max(fy, 0.0), H - 1.001)
            xi, yi = int(x), int(y)
            dx, dy = x - xi, y - yi
            a = mosaic[yi, xi]
            b = mosaic[yi, xi + 1]
            cc = mosaic[yi + 1, xi]
            d = mosaic[yi + 1, xi + 1]
            vals = [v for v in (a, b, cc, d) if not _np.isnan(v)]
            if not vals:
                grid[r, c] = _np.nan
            else:
                # Bilinear over valid neighbours (renormalized if a corner is void)
                w = [(1 - dx) * (1 - dy), dx * (1 - dy), (1 - dx) * dy, dx * dy]
                num = sum(v * ww for v, ww in zip((a, b, cc, d), w) if not _np.isnan(v))
                den = sum(ww for v, ww in zip((a, b, cc, d), w) if not _np.isnan(v))
                grid[r, c] = num / den if den > 0 else _np.nan
    if bool(_np.isnan(grid).all()):
        raise ValueError("Terrarium mosaic all-void for bbox")
    logger.info(f"[DEM-Tiles] z{z} terrarium grid {rows}x{cols} from {(x1-x0+1)*(y1-y0+1)} tiles")
    return {"grid": grid, "source": "AWS Terrain Tiles (SRTM 30m, Terrarium z15)"}
