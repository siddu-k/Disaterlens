"""
DisasterLens — Microsoft GlobalML Building Footprints fast lookup.
===============================================================
Precomputed DNN building polygons (1.4B worldwide, Bing/Maxar/Airbus
imagery 2014-2024) served from bfppub.blob.core.windows.net partitioned
by Bing Tile quadkey (level 9). No local weights, no inference — just
fast HTTP fetch + centroid/area math. Faster than optical contour CV
and higher recall than OSM in rural areas.

Dataset: https://github.com/microsoft/GlobalMLBuildingFootprints
Index:   https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv
Format:  Location,QuadKey,Url,Size,UploadDate  (QuadKey = level-9 string)
Tiles:   .csv.gz files whose contents are GeoJSONL Features with
         Polygon coords [lon,lat] + properties {confidence, height}.
License: CDLA Permissive 2.0 (source labelled "Microsoft GlobalML").
"""

import csv
import gzip
import logging
import math
import os
import time
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

DATASET_LINKS_URL = (
    "https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv"
)
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "ms_buildings")
INDEX_TTL_S = 30 * 24 * 3600
TILE_TIMEOUT_S = 15.0
INDEX_TIMEOUT_S = 60.0
MAX_TILES_PER_QUERY = 6
MAX_BUILDINGS = 1000


def latlon_to_tile(lat: float, lon: float, level: int):
    lat = max(-85.05112878, min(85.05112878, lat))
    n = 2.0 ** level
    xtile = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    xtile = max(0, min(int(n) - 1, xtile))
    ytile = max(0, min(int(n) - 1, ytile))
    return xtile, ytile


def tile_to_quadkey(xtile: int, ytile: int, level: int) -> str:
    qk = []
    for i in range(level, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if (xtile & mask) != 0:
            digit += 1
        if (ytile & mask) != 0:
            digit += 2
        qk.append(str(digit))
    return "".join(qk)


def covering_quadkeys(bbox: Dict[str, float], level: int = 9) -> List[str]:
    s, w, n, e = bbox["south"], bbox["west"], bbox["north"], bbox["east"]
    mid_lat, mid_lon = (s + n) / 2.0, (w + e) / 2.0
    pts = [(s, w), (s, e), (n, w), (n, e), (mid_lat, mid_lon),
           (s, mid_lon), (n, mid_lon), (mid_lat, w), (mid_lat, e)]
    out = []
    for lat, lon in pts:
        qk = tile_to_quadkey(*latlon_to_tile(lat, lon, level), level)
        if qk not in out:
            out.append(qk)
    return out


def _index_path() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, "dataset-links.csv")


def _load_index() -> Dict[str, List[str]]:
    """QuadKey -> list of tile URLs (a quadkey can have Asia + country parts),
    cached on disk for 30d. Downloads 6.3MB once."""
    path = _index_path()
    if os.path.exists(path) and (time.time() - os.path.getmtime(path)) < INDEX_TTL_S:
        pass
    else:
        logger.info("[MS-Buildings] downloading dataset-links.csv index (~6MB, once per 30d)…")
        resp = requests.get(DATASET_LINKS_URL, timeout=INDEX_TIMEOUT_S)
        resp.raise_for_status()
        with open(path, "wb") as f:
            f.write(resp.content)
    index: Dict[str, List[str]] = {}
    with open(path, "r", newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            qk, url = (row.get("QuadKey") or "").strip(), (row.get("Url") or "").strip()
            if qk and url and url not in index.setdefault(qk, []):
                index[qk].append(url)
    return index


def _polygon_centroid_area_sqm(ring) -> Optional[tuple]:
    if not ring or len(ring) < 4:
        return None
    # ring: [[lon,lat]...] closed. Shoelace in degrees + equirectangular scale.
    area_deg2 = 0.0
    cx_deg = cy_deg = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        cross = x0 * y1 - x1 * y0
        area_deg2 += cross
        cx_deg += (x0 + x1) * cross
        cy_deg += (y0 + y1) * cross
    area_deg2 *= 0.5
    if abs(area_deg2) < 1e-14:
        return None
    cx_deg /= (6.0 * area_deg2)
    cy_deg /= (6.0 * area_deg2)
    m_per_deg_lat = 111320.0
    m_per_deg_lon = 111320.0 * math.cos(math.radians(cy_deg))
    area_sqm = abs(area_deg2) * m_per_deg_lat * m_per_deg_lon
    return cy_deg, cx_deg, area_sqm


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def fuse_ms_into_geodata(
    geodata: Dict[str, Any],
    bbox: Dict[str, float],
    limit: int = 2500,
    dedupe_m: float = 18.0,
    preloaded: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Fuse Microsoft GlobalML houses into OSM simulation geodata (in place).

    Role split: OSM keeps roads + facilities (hospitals/schools/...) + mapped
    buildings; MS adds ONLY unmapped houses/buildings (>= ``dedupe_m`` from any
    OSM centroid), converted to the OSM building dict shape so
    ``analyze_impact`` and the map consume them unchanged.
    Best-effort: MS outage returns ``ms_added: 0`` and leaves geodata intact.
    """
    info: Dict[str, Any] = {"ms_added": 0, "osm_buildings": 0, "ms_skipped_dupes": 0}
    try:
        osm_buildings = geodata.get("buildings", []) or []
        info["osm_buildings"] = len(osm_buildings)
        ms = preloaded if preloaded is not None else fetch_ms_buildings(bbox, limit=limit)
        existing = []
        for b in osm_buildings:
            # Synthetic fallback buildings are fake grid points — never let them
            # veto real Microsoft houses. Dedupe only against real OSM geometry.
            if b.get("source") == "synthetic":
                continue
            c = b.get("centroid") or {}
            if c.get("lat") is not None and c.get("lon") is not None:
                existing.append((c["lat"], c["lon"]))
        added = 0
        for i, m in enumerate(ms.get("buildings", []) or []):
            dup = False
            for e_lat, e_lon in existing:
                if _haversine_m(m["lat"], m["lon"], e_lat, e_lon) < dedupe_m:
                    dup = True
                    break
            if dup:
                info["ms_skipped_dupes"] += 1
                continue
            osm_buildings.append({
                "id": f"ms-{m.get('id', i)}",
                "name": f"MS House #{i}",
                "type": "house",
                "centroid": {"lat": m["lat"], "lon": m["lon"]},
                "area_sqm": m.get("area_sqm"),
                "levels": 1,
                "height_m": 3.2,
                "flooded": False,
                "flood_depth": 0.0,
                "amenity": None,
                "source": "Microsoft GlobalML",
                "confidence": m.get("confidence", 0.90),
            })
            existing.append((m["lat"], m["lon"]))
            added += 1
        info["ms_added"] = added
        geodata["ms_fused"] = info
        try:
            stats = geodata.setdefault("stats", {})
            stats["total_buildings"] = len(osm_buildings)
            stats["ms_buildings_added"] = added
        except Exception:
            pass
        logger.info(f"[MS-Fusion] +{added} MS houses into {info['osm_buildings']} OSM buildings")
    except Exception as ex:
        logger.warning(f"[MS-Fusion] failed (best-effort, OSM only): {ex}")
        info["error"] = str(ex)
        geodata["ms_fused"] = info
    return info


def fetch_ms_buildings(
    bbox: Dict[str, float], limit: int = MAX_BUILDINGS
) -> Dict[str, Any]:
    """Fetch Microsoft GlobalML footprints whose centroid falls inside bbox.

    Returns {"buildings": [{lat,lon,area_sqm,confidence,source,id}...],
             "tiles_queried": int, "tiles_hit": int}.
    Never raises — failures return empty list + error string for logging.
    """
    import io as _io

    s, w, n, e = bbox["south"], bbox["west"], bbox["north"], bbox["east"]
    try:
        index = _load_index()
    except Exception as ex:
        logger.warning(f"[MS-Buildings] index unavailable: {ex}")
        return {"buildings": [], "tiles_queried": 0, "tiles_hit": 0, "error": str(ex)}

    qks = covering_quadkeys(bbox)[:MAX_TILES_PER_QUERY]
    out: List[Dict[str, Any]] = []
    hits = 0
    tile_no = 0
    for qk in qks:
        if len(out) >= limit:
            break
        for url in index.get(qk, []):
            if len(out) >= limit:
                break
            tile_no += 1
            if tile_no > MAX_TILES_PER_QUERY * 2:
                break
            tile_path = os.path.join(CACHE_DIR, f"tile-{qk}-{tile_no}.csv.gz")
            try:
                if not os.path.exists(tile_path):
                    r = requests.get(url, timeout=TILE_TIMEOUT_S)
                    r.raise_for_status()
                    with open(tile_path, "wb") as f:
                        f.write(r.content)
                with open(tile_path, "rb") as f:
                    raw = gzip.decompress(f.read()).decode("utf-8", errors="replace")
            except Exception as ex:
                logger.warning(f"[MS-Buildings] tile {qk} fetch failed: {ex}")
                continue
            hits += 1
            for line in raw.splitlines():
                if len(out) >= limit:
                    break
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    import json as _json
                    feat = _json.loads(line)
                    geom = feat.get("geometry") or {}
                    coords = geom.get("coordinates")
                    ring = coords[0] if isinstance(coords, list) and coords else None
                    if geom.get("type") != "Polygon" or not ring:
                        continue
                    ca = _polygon_centroid_area_sqm(ring)
                    if ca is None:
                        continue
                    c_lat, c_lon, area_sqm = ca
                    if not (s <= c_lat <= n and w <= c_lon <= e):
                        continue
                    if not (10.0 <= area_sqm <= 10000.0):
                        continue
                    props = feat.get("properties") or {}
                    try:
                        conf = float(props.get("confidence", 0.90))
                    except (TypeError, ValueError):
                        conf = 0.90
                    if conf <= 0 or conf > 1:
                        conf = 0.90
                    out.append({
                        "id": f"ms-{qk}-{len(out)}",
                        "type": "building",
                        "lat": round(c_lat, 5),
                        "lon": round(c_lon, 5),
                        "area_sqm": round(area_sqm, 1),
                        "confidence": round(conf, 3),
                        "source": "Microsoft GlobalML",
                    })
                except Exception:
                    continue
    logger.info(f"[MS-Buildings] {len(out)} footprints from {hits}/{len(qks)} tiles")
    return {"buildings": out, "tiles_queried": len(qks), "tiles_hit": hits}
