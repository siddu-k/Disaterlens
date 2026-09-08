"""
DisasterLens — Satellite-Vision Proxy (OSM-vector v1)
=====================================================
Object detection + change detection over detection snapshots.

v1 honesty contract: no ML vision model weights or multi-date imagery keys
exist in this project, so detections are derived from live OSM vector data
(real buildings/roads geometry) with deterministic derived confidence.
NEVER claim a vision model ran — sources are "OpenStreetMap" (live) or
"synthetic" (offline procedural fallback, confidence discounted).

A real pre-trained vision model can plug in later via MODEL_REGISTRY +
run_model_inference without changing the endpoint shapes.
"""

import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from geodata.osm import fetch_geodata

logger = logging.getLogger(__name__)

MODEL_REGISTRY: Dict[str, Dict[str, Any]] = {
    "osm-vector": {
        "name": "OSM vector proxy",
        "active": True,
        "notes": "real OSM geometry; plug pre-trained vision models here",
    }
}

ALLOWED_OBJECT_TYPES = {"building", "road", "water", "tree", "solar"}

# Types that require real vision-model inference (fetch_geodata exposes no
# water/tree/solar layer) — honestly reported as unavailable.
VISION_ONLY_TYPES = ("water", "tree", "solar")
VISION_ONLY_REASON = "requires vision-model inference (not connected)"

_MODIFIED_DISTANCE_M = 15.0
_MODIFIED_AREA_FRAC = 0.20


def run_model_inference(model_id: str, bbox: Dict[str, float]) -> Dict[str, Any]:
    """Plug-in point for future pre-trained vision models.

    The "osm-vector" proxy is served via detect_objects(); every other
    model id (unknown or non-active) raises NotImplementedError.
    """
    entry = MODEL_REGISTRY.get(model_id)
    if entry is None or not entry.get("active", False) or model_id != "osm-vector":
        raise NotImplementedError(
            f"Vision model '{model_id}' is not connected; "
            "available active models: "
            + ", ".join(m for m, e in MODEL_REGISTRY.items() if e.get("active"))
        )
    raise NotImplementedError(
        "The 'osm-vector' proxy is served via detect_objects(), not run_model_inference()."
    )


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


def detect_objects(bbox: Dict[str, float], object_types: List[str]) -> Dict[str, Any]:
    """Derive object detections from live OSM vector data for a bbox.

    Supports building/road fully; water/tree/solar honestly return empty
    (reported in not_available_types). Raises ValueError on unknown types.
    """
    requested = list(object_types or [])
    unknown = [t for t in requested if t not in ALLOWED_OBJECT_TYPES]
    if unknown:
        raise ValueError(f"Unknown object_types: {unknown}. Allowed: {sorted(ALLOWED_OBJECT_TYPES)}")
    wanted = set(requested)
    not_available = [t for t in requested if t in VISION_ONLY_TYPES]

    try:
        data = fetch_geodata(bbox["south"], bbox["west"], bbox["north"], bbox["east"])
    except Exception as e:
        logger.warning(f"[SatVision] geodata fetch failed, returning empty detections: {e}")
        return _empty_result(is_synthetic=True, not_available=not_available)

    is_synthetic = bool(data.get("is_synthetic", False))
    detections: List[Dict[str, Any]] = []

    def _source_of(feat: Dict[str, Any]) -> str:
        return "synthetic" if feat.get("source") == "synthetic" else "OpenStreetMap"

    def _discount(conf: float, feat: Dict[str, Any]) -> float:
        if feat.get("source") == "synthetic":
            return round(conf * 0.6, 3)
        return conf

    if "building" in wanted:
        for b in data.get("buildings", []) or []:
            centroid = b.get("centroid") or {}
            if centroid.get("lat") is None or centroid.get("lon") is None:
                continue
            has_attrs = bool(b.get("levels")) or bool(b.get("area_sqm"))
            conf = 0.92 if has_attrs else 0.78
            area = b.get("area_sqm")
            detections.append(
                {
                    "id": f"building-{b.get('id')}",
                    "type": "building",
                    "lat": centroid.get("lat"),
                    "lon": centroid.get("lon"),
                    "area_sqm": area,
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

    by_type: Dict[str, int] = {}
    for d in detections:
        by_type[d["type"]] = by_type.get(d["type"], 0) + 1
    area_covered = round(sum(d["area_sqm"] for d in detections if d.get("area_sqm") is not None) or 0.0, 1)
    mean_conf = round(sum(d["confidence"] for d in detections) / len(detections), 3) if detections else 0.0

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
