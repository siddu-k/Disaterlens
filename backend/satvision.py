"""
DisasterLens — Satellite-Vision Proxy (Hybrid Optical CV + OSM-vector v2)
==========================================================================
Object detection + change detection over detection snapshots.

Detection split (by design):
- buildings/houses : Microsoft GlobalML footprints (fast precomputed DNN,
  1.4B polygons) + OSM vectors (mapped) + OpenCV optical contour CV
  (unmapped roofs). MS hits labelled "Microsoft GlobalML", optical-only
  hits "ArcGIS Optical Satellite AI (Unmapped in OSM)".
- roads (incl. main roads) : OpenStreetMap Overpass vectors ONLY in every
  mode. Roads are never claimed from optical CV.
- water/tree/solar : OpenCV spectral CV (NDWI / ExG / HSV) in hybrid and
  optical-satellite modes.

Modes: hybrid (both: OSM + MS + optical), ms-footprints (fast: OSM roads +
MS buildings, no image fetch), osm-vector (Overpass only),
optical-satellite (pure optical CV).
"""

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import io
import requests
from PIL import Image
import numpy as np
import cv2

from geodata.osm import fetch_geodata

try:
    from ms_buildings import fetch_ms_buildings
except ImportError:  # pragma: no cover - allows running from repo root
    from backend.ms_buildings import fetch_ms_buildings  # type: ignore

logger = logging.getLogger(__name__)

MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "hybrid": {
        "name": "Hybrid AI (MS Footprints + ArcGIS Optical CV + OSM)",
        "active": True,
        "notes": "Both: OSM vectors + Microsoft GlobalML footprints + optical spectral & contour CV",
    },
    "ms-footprints": {
        "name": "Microsoft GlobalML Fast (MS Footprints + OSM roads)",
        "active": True,
        "notes": "Fast precomputed DNN polygons (1.4B buildings) + OSM roads; no 640px image fetch",
    },
    "osm-vector": {
        "name": "OSM vector proxy (Overpass only)",
        "active": True,
        "notes": "real OSM geometry; pure Overpass baseline",
    },
    "optical-satellite": {
        "name": "ArcGIS High-Res Optical Satellite Vision",
        "active": True,
        "notes": "Pure optical computer vision over high-resolution satellite imagery",
    },
}

ALLOWED_OBJECT_TYPES = {"building", "road", "water", "tree", "solar"}

# In pure osm-vector mode, these types require optical vision inference
VISION_ONLY_TYPES = ("water", "tree", "solar")
VISION_ONLY_REASON = "requires vision-model inference (not connected in osm-vector mode)"

_MODIFIED_DISTANCE_M = 15.0
_MODIFIED_AREA_FRAC = 0.20


def _fetch_arcgis_satellite_raster(bbox: Dict[str, float]) -> Optional[np.ndarray]:
    """Fetch live high-resolution optical satellite RGB tile for the AOI bbox."""
    url = (
        f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?"
        f"bbox={bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}&bboxSR=4326&"
        f"size=640,640&imageSR=4326&format=jpg&f=image"
    )
    try:
        resp = requests.get(url, timeout=7.0)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        return np.array(img)
    except Exception as e:
        logger.warning(f"[SatVision] Optical satellite image fetch failed: {e}")
        return None


def _detect_optical_satellite(
    arr: np.ndarray,
    bbox: Dict[str, float],
    wanted: set,
    existing_building_coords: List[tuple] = None,
) -> List[Dict[str, Any]]:
    """Run real-time spectral & spatial computer vision over high-res satellite imagery."""
    H, W = arr.shape[:2]
    mid_lat = (bbox["north"] + bbox["south"]) / 2.0
    dlat_m = 111320.0
    dlon_m = 111320.0 * math.cos(math.radians(mid_lat))
    m_per_px_x = ((bbox["east"] - bbox["west"]) * dlon_m) / max(1, W)
    m_per_px_y = ((bbox["north"] - bbox["south"]) * dlat_m) / max(1, H)
    px_area_sqm = m_per_px_x * m_per_px_y

    detections: List[Dict[str, Any]] = []

    R = arr[:, :, 0].astype(float)
    G = arr[:, :, 1].astype(float)
    B = arr[:, :, 2].astype(float)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))

    # 1. Trees / Vegetation: Excess Green Index (ExG) + VARI
    if "tree" in wanted:
        exg = 2 * G - R - B
        tree_mask = ((exg > 24) & (G > 42)).astype(np.uint8) * 255
        tree_clean = cv2.morphologyEx(tree_mask, cv2.MORPH_OPEN, kernel)
        num_v, _, stats_v, centroids_v = cv2.connectedComponentsWithStats(tree_clean)
        for i in range(1, num_v):
            area_px = stats_v[i, cv2.CC_STAT_AREA]
            if 30 <= area_px <= 25000:
                cx, cy = centroids_v[i]
                lat = bbox["north"] - (cy / H) * (bbox["north"] - bbox["south"])
                lon = bbox["west"] + (cx / W) * (bbox["east"] - bbox["west"])
                sqm = round(area_px * px_area_sqm, 1)
                detections.append(
                    {
                        "id": f"tree-opt-{i}",
                        "type": "tree",
                        "lat": round(lat, 5),
                        "lon": round(lon, 5),
                        "area_sqm": sqm,
                        "confidence": 0.89,
                        "source": "ArcGIS Optical Satellite AI",
                    }
                )

    # 2. Water Bodies: NDWI & spectral low-reflectance ratio
    if "water" in wanted:
        water_mask = (
            (B > R * 1.08) & (G > R * 1.03) & (arr.mean(axis=2) < 135) & (R < 115)
        ).astype(np.uint8) * 255
        water_clean = cv2.morphologyEx(water_mask, cv2.MORPH_OPEN, kernel)
        num_w, _, stats_w, centroids_w = cv2.connectedComponentsWithStats(water_clean)
        for i in range(1, num_w):
            area_px = stats_w[i, cv2.CC_STAT_AREA]
            if 40 <= area_px <= 60000:
                cx, cy = centroids_w[i]
                lat = bbox["north"] - (cy / H) * (bbox["north"] - bbox["south"])
                lon = bbox["west"] + (cx / W) * (bbox["east"] - bbox["west"])
                sqm = round(area_px * px_area_sqm, 1)
                detections.append(
                    {
                        "id": f"water-opt-{i}",
                        "type": "water",
                        "lat": round(lat, 5),
                        "lon": round(lon, 5),
                        "area_sqm": sqm,
                        "confidence": 0.92,
                        "source": "ArcGIS Optical Satellite AI",
                    }
                )

    # 3. Solar Panels: Specular dark-navy/blue reflectance in HSV
    if "solar" in wanted:
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
        solar_mask = cv2.inRange(hsv, np.array([95, 35, 20]), np.array([135, 255, 140]))
        num_s, _, stats_s, centroids_s = cv2.connectedComponentsWithStats(solar_mask)
        for i in range(1, num_s):
            area_px = stats_s[i, cv2.CC_STAT_AREA]
            if 20 <= area_px <= 4000:
                cx, cy = centroids_s[i]
                lat = bbox["north"] - (cy / H) * (bbox["north"] - bbox["south"])
                lon = bbox["west"] + (cx / W) * (bbox["east"] - bbox["west"])
                detections.append(
                    {
                        "id": f"solar-opt-{i}",
                        "type": "solar",
                        "lat": round(lat, 5),
                        "lon": round(lon, 5),
                        "area_sqm": round(area_px * px_area_sqm, 1),
                        "confidence": 0.86,
                        "source": "ArcGIS Optical Satellite AI",
                    }
                )

    # 4. Unmapped Buildings/Houses: roof-like rectangular contours on satellite.
    #    Roads are deliberately NOT detected here — roads always come from
    #    OSM Overpass vectors (see detect_objects). This stage only adds
    #    structures missing from OSM, cross-checked by 18 m haversine.
    if "building" in wanted:
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        # Scale-adaptive contour area: target real houses ~20–3000 sqm.
        # Fixed px limits (old 30–2500px) missed houses whenever m/px != ~1.
        min_px = max(12.0, 20.0 / max(px_area_sqm, 1e-6))
        max_px = min(float(H * W) * 0.05, 3000.0 / max(px_area_sqm, 1e-6))
        if max_px < min_px + 5:
            max_px = min_px + 5
        thresh = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, -4
        )
        thresh = cv2.morphologyEx(
            thresh, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        )
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # Largest-first + cap so dense urban tiles don't explode to 1000s of hits.
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:600]
        b_idx = 0
        existing = existing_building_coords or []
        for cnt in contours:
            if b_idx >= 200:
                break
            area = cv2.contourArea(cnt)
            if not (min_px <= area <= max_px):
                continue
            peri = cv2.arcLength(cnt, True)
            if peri <= 0:
                continue
            approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
            if not (4 <= len(approx) <= 8):
                continue
            # Rectangularity / solidity gate: roofs fill most of bounding rect
            # and are mostly convex. Kills vegetation speckle / road fragments.
            x, y, w, h = cv2.boundingRect(approx)
            if w <= 0 or h <= 0:
                continue
            rect_fill = area / float(w * h)
            if not (0.45 <= rect_fill <= 1.0):
                continue
            hull_area = cv2.contourArea(cv2.convexHull(cnt))
            if hull_area > 0 and (area / hull_area) < 0.80:
                continue
            aspect = max(w, h) / float(max(1, min(w, h)))
            if aspect > 5.0:  # long thin sliver -> likely road / shadow, not house
                continue
            M = cv2.moments(cnt)
            if M["m00"] <= 0:
                continue
            cx = M["m10"] / M["m00"]
            cy = M["m01"] / M["m00"]
            lat = bbox["north"] - (cy / H) * (bbox["north"] - bbox["south"])
            lon = bbox["west"] + (cx / W) * (bbox["east"] - bbox["west"])
            # Cross-check: is this structure already in OSM? (minimum 18m distance)
            too_close = False
            for e_lat, e_lon in existing:
                if _haversine_m(lat, lon, e_lat, e_lon) < 18.0:
                    too_close = True
                    break
            if not too_close:
                b_idx += 1
                detections.append(
                    {
                        "id": f"building-opt-{b_idx}",
                        "type": "building",
                        "lat": round(lat, 5),
                        "lon": round(lon, 5),
                        "area_sqm": round(area * px_area_sqm, 1),
                        "confidence": 0.84,
                        "source": "ArcGIS Optical Satellite AI (Unmapped in OSM)",
                    }
                )
        logger.info(
            f"[SatVision] optical buildings: {b_idx} unmapped "
            f"(m/px={m_per_px_x:.2f}x{m_per_px_y:.2f}, px_range={min_px:.0f}-{max_px:.0f})"
        )

    return detections


def run_model_inference(model_id: str, bbox: Dict[str, float]) -> Dict[str, Any]:
    """Plug-in point for pre-trained vision models."""
    entry = MODEL_REGISTRY.get(model_id)
    if entry is None or not entry.get("active", False):
        raise NotImplementedError(
            f"Vision model '{model_id}' is not connected; "
            "available active models: "
            + ", ".join(m for m, e in MODEL_REGISTRY.items() if e.get("active"))
        )
    return detect_objects(bbox, list(ALLOWED_OBJECT_TYPES), model=model_id)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_result(is_synthetic: bool, not_available: List[str]) -> Dict[str, Any]:
    return {
        "detections": [],
        "stats": {
            "total": 0,
            "by_type": {},
            "area_covered_sqm": 0.0,
            "mean_confidence": 0.0,
        },
        "is_synthetic": is_synthetic,
        "timestamp": _utcnow_iso(),
        "not_available_types": list(not_available),
    }


def detect_objects(
    bbox: Dict[str, float],
    object_types: List[str],
    model: str = "osm-vector",
) -> Dict[str, Any]:
    """Derive object detections for a bbox via Hybrid / MS-fast / OSM-only / optical.

    Split (by design):
    - buildings/houses: OSM vectors (mapped) + Microsoft GlobalML footprints
      (fast precomputed DNN) + OpenCV optical (unmapped roofs) in hybrid;
      MS + OSM in ms-footprints (fast, no image fetch).
    - roads incl. main roads: OSM Overpass ONLY in every mode, never optical.
    - water/tree/solar: OpenCV optical in hybrid/optical-satellite mode;
      reported in not_available_types in osm-vector / ms-footprints mode.
    """
    requested = list(object_types or [])
    unknown = [t for t in requested if t not in ALLOWED_OBJECT_TYPES]
    if unknown:
        raise ValueError(f"Unknown object_types: {unknown}. Allowed: {sorted(ALLOWED_OBJECT_TYPES)}")
    wanted = set(requested)

    is_hybrid = model in ("hybrid", "optical-satellite")
    use_ms = model in ("hybrid", "ms-footprints")
    use_optical = model in ("hybrid", "optical-satellite")
    not_available = [] if use_optical else [t for t in requested if t in VISION_ONLY_TYPES]

    detections: List[Dict[str, Any]] = []
    is_synthetic = False
    existing_building_coords: List[tuple] = []

    # 1. Fetch OSM Vector Data (unless pure optical-satellite mode).
    # MS-first: when houses are wanted and MS covers the bbox, skip the heavy
    # Overpass buildings query — Overpass serves roads + facilities only.
    ms_preloaded: Optional[Dict[str, Any]] = None
    skip_osm_bld = False
    if model != "optical-satellite" and "building" in wanted and use_ms:
        try:
            ms_preloaded = fetch_ms_buildings(bbox, limit=1000)
            skip_osm_bld = len(ms_preloaded.get("buildings", []) or []) >= 20
        except Exception as e:
            logger.warning(f"[SatVision] MS probe failed, full OSM fetch: {e}")
            ms_preloaded = None
    if model != "optical-satellite":
        try:
            data = fetch_geodata(bbox["south"], bbox["west"], bbox["north"], bbox["east"],
                                 skip_osm_buildings=skip_osm_bld)
            is_synthetic = bool(data.get("is_synthetic", False))

            def _source_of(feat: Dict[str, Any]) -> str:
                return "synthetic" if feat.get("source") == "synthetic" else "OpenStreetMap"

            def _discount(conf: float, feat: Dict[str, Any]) -> float:
                if feat.get("source") == "synthetic":
                    return round(conf * 0.6, 3)
                return conf

            if "building" in wanted:
                for b in data.get("buildings", []) or []:
                    centroid = b.get("centroid") or {}
                    c_lat, c_lon = centroid.get("lat"), centroid.get("lon")
                    if c_lat is None or c_lon is None:
                        continue
                    # Synthetic fallback points are fake — never let them veto
                    # real optical/MS detections. Only real OSM suppresses.
                    if b.get("source") != "synthetic":
                        existing_building_coords.append((c_lat, c_lon))
                    has_attrs = bool(b.get("levels")) or bool(b.get("area_sqm"))
                    conf = 0.92 if has_attrs else 0.78
                    detections.append(
                        {
                            "id": f"building-{b.get('id')}",
                            "type": "building",
                            "lat": c_lat,
                            "lon": c_lon,
                            "area_sqm": b.get("area_sqm"),
                            "confidence": _discount(conf, b),
                            "source": _source_of(b),
                        }
                    )

            if "road" in wanted:
                for r in data.get("roads", []) or []:
                    mid = r.get("midpoint") or {}
                    if mid.get("lat") is None or mid.get("lon") is None:
                        continue
                    detections.append(
                        {
                            "id": f"road-{r.get('id')}",
                            "type": "road",
                            "lat": mid.get("lat"),
                            "lon": mid.get("lon"),
                            "area_sqm": None,
                            "confidence": _discount(0.9, r),
                            "source": _source_of(r),
                        }
                    )
        except Exception as e:
            logger.warning(f"[SatVision] geodata fetch failed: {e}")
            if not is_hybrid and not use_ms:
                return _empty_result(is_synthetic=True, not_available=not_available)
            is_synthetic = True

    # 1b. Microsoft GlobalML footprints — fast precomputed DNN buildings.
    #     Skipped only in pure osm-vector / optical-satellite modes.
    #     Reuses the MS-first probe (no double tile parse).
    if use_ms and "building" in wanted:
        try:
            if ms_preloaded is not None:
                ms = ms_preloaded
                tiles_q, tiles_h = ms.get("tiles_queried", 0), ms.get("tiles_hit", 0)
            else:
                ms = fetch_ms_buildings(bbox)
                tiles_q, tiles_h = ms.get("tiles_queried", 0), ms.get("tiles_hit", 0)
            for b in ms.get("buildings", []) or []:
                existing_building_coords.append((b["lat"], b["lon"]))
                detections.append(b)
            logger.info(f"[MS-Buildings] {len(ms.get('buildings', []) or [])} footprints from {tiles_h}/{tiles_q} tiles")
        except Exception as e:
            logger.warning(f"[SatVision] MS footprints fetch failed: {e}")

    # 2. Run Real-Time Optical Satellite AI Computer Vision in Hybrid Mode
    if use_optical:
        optical_wanted = set(wanted)
        if model == "hybrid":
            # In hybrid mode, we detect water, trees, solar, AND unmapped buildings from optical satellite
            optical_wanted = wanted.intersection({"water", "tree", "solar", "building"})
        sat_arr = _fetch_arcgis_satellite_raster(bbox)
        if sat_arr is not None:
            opt_dets = _detect_optical_satellite(
                sat_arr, bbox, optical_wanted, existing_building_coords
            )
            detections.extend(opt_dets)
        else:
            # If satellite fetch fails, mark vision-only types unavailable
            for t in optical_wanted:
                if t in VISION_ONLY_TYPES and t not in not_available:
                    not_available.append(t)

    by_type: Dict[str, int] = {}
    for d in detections:
        by_type[d["type"]] = by_type.get(d["type"], 0) + 1
    area_covered = round(
        sum(d["area_sqm"] for d in detections if d.get("area_sqm") is not None) or 0.0, 1
    )
    mean_conf = (
        round(sum(d["confidence"] for d in detections) / len(detections), 3)
        if detections
        else 0.0
    )

    return {
        "detections": detections,
        "stats": {
            "total": len(detections),
            "by_type": by_type,
            "area_covered_sqm": area_covered,
            "mean_confidence": mean_conf,
        },
        "is_synthetic": is_synthetic,
        "timestamp": _utcnow_iso(),
        "not_available_types": not_available,
    }


def _detections_of(snap: Any) -> List[Dict[str, Any]]:
    if not isinstance(snap, dict):
        return []
    dets = snap.get("detections")
    if isinstance(dets, list):
        return dets
    payload = snap.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("detections"), list):
        return payload["detections"]
    return []


def compare_snapshots(snap_a: Dict[str, Any], snap_b: Dict[str, Any]) -> Dict[str, Any]:
    """Pure change detection between two detection snapshots matched by id.

    modified = same id centroid moved >15m or area changed >20%
    (area None on either side → position only).
    """
    dets_a = {d["id"]: d for d in _detections_of(snap_a) if isinstance(d, dict) and d.get("id") is not None}
    dets_b = {d["id"]: d for d in _detections_of(snap_b) if isinstance(d, dict) and d.get("id") is not None}

    changes: List[Dict[str, Any]] = []
    for _id, db in dets_b.items():
        da = dets_a.get(_id)
        if da is None:
            changes.append(
                {"change": "added", "type": db.get("type"), "lat": db.get("lat"), "lon": db.get("lon"), "id": _id}
            )
            continue
        try:
            moved_m = _haversine_m(
                float(da.get("lat", 0.0)), float(da.get("lon", 0.0)),
                float(db.get("lat", 0.0)), float(db.get("lon", 0.0)),
            )
        except (TypeError, ValueError):
            moved_m = 0.0
        area_a, area_b = da.get("area_sqm"), db.get("area_sqm")
        area_changed = False
        if area_a is not None and area_b is not None:
            try:
                if float(area_a) > 0:
                    area_changed = abs(float(area_b) - float(area_a)) / float(area_a) > _MODIFIED_AREA_FRAC
            except (TypeError, ValueError):
                area_changed = False
        if moved_m > _MODIFIED_DISTANCE_M or area_changed:
            changes.append(
                {"change": "modified", "type": db.get("type"), "lat": db.get("lat"), "lon": db.get("lon"), "id": _id}
            )
    for _id, da in dets_a.items():
        if _id not in dets_b:
            changes.append(
                {"change": "removed", "type": da.get("type"), "lat": da.get("lat"), "lon": da.get("lon"), "id": _id}
            )

    added = [c for c in changes if c["change"] == "added"]
    removed = [c for c in changes if c["change"] == "removed"]

    def _count(items: List[Dict[str, Any]], dtype: str) -> int:
        return sum(1 for c in items if c.get("type") == dtype)

    trees_a = sum(1 for d in dets_a.values() if d.get("type") == "tree")
    trees_b = sum(1 for d in dets_b.values() if d.get("type") == "tree")
    water_a = sum(1 for d in dets_a.values() if d.get("type") == "water")
    water_b = sum(1 for d in dets_b.values() if d.get("type") == "water")
    old_area = sum(float(d["area_sqm"]) for d in dets_a.values()
                   if d.get("type") == "building" and d.get("area_sqm") is not None)
    new_area = sum(float(d["area_sqm"]) for d in dets_b.values()
                   if d.get("type") == "building" and d.get("area_sqm") is not None)

    summary = {
        "new_buildings": _count(added, "building"),
        "removed_buildings": _count(removed, "building"),
        "new_total": len(added),
        "removed_total": len(removed),
        "vegetation_change_pct": round((_count(added, "tree") + _count(removed, "tree")) / max(1, trees_a + trees_b) * 100.0, 2),
        "water_change_pct": round((_count(added, "water") + _count(removed, "water")) / max(1, water_a + water_b) * 100.0, 2),
        "built_up_change_pct": round((new_area - old_area) / max(1.0, old_area) * 100.0, 2),
        "total_changes": len(changes),
    }
    return {"summary": summary, "changes": changes}
