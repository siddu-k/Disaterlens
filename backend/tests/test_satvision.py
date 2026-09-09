"""
DisasterLens — Satellite-Vision endpoint tests (hermetic, no network)
======================================================================
Monkeypatches satvision.fetch_geodata with tiny canned payloads; snapshot
rows written to the real sqlite cache are deleted in teardown by id.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

import main
from main import app

client = TestClient(app)

# Remote-ocean bbox: unique per module to avoid real-cache interference
BBOX = {"south": -32.10, "west": 150.10, "north": -32.00, "east": 150.20}

_created_ids: list = []


def _track(snapshot_id):
    _created_ids.append(snapshot_id)
    return snapshot_id


def _canned_one_building_one_road():
    return {
        "buildings": [
            {
                "id": 1,
                "centroid": {"lat": -32.05, "lon": 150.15},
                "area_sqm": 200.0,
                "levels": 2,
            }
        ],
        "roads": [
            {"id": 10, "midpoint": {"lat": -32.06, "lon": 150.16}},
        ],
        "is_synthetic": False,
    }


def _canned_two_buildings():
    return {
        "buildings": [
            {
                "id": 1,
                "centroid": {"lat": -32.05, "lon": 150.15},
                "area_sqm": 200.0,
                "levels": 2,
            },
            {
                "id": 2,
                "centroid": {"lat": -32.07, "lon": 150.18},
                "area_sqm": 300.0,
                "levels": 3,
            },
        ],
        "roads": [],
        "is_synthetic": False,
    }


def _cleanup_rows():
    import sqlite3
    from db.spatial_store import DB_PATH, _ensure_satvision_table, _connect

    conn = _connect()
    try:
        _ensure_satvision_table(conn)
        for sid in list(_created_ids):
            try:
                conn.execute("DELETE FROM satvision_snapshots WHERE id = ?", (sid,))
            except Exception:
                pass
        conn.commit()
    finally:
        conn.close()
    _created_ids.clear()


def teardown_function(function=None):
    _cleanup_rows()


def test_detect_returns_stats(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building", "road"]})
    assert res.status_code == 200
    data = res.json()
    _track(data["snapshot_id"])
    assert data["stats"]["total"] == 2
    assert data["stats"]["by_type"] == {"building": 1, "road": 1}
    assert data["stats"]["area_covered_sqm"] == 200.0
    assert data["stats"]["mean_confidence"] > 0
    assert data["is_synthetic"] is False
    assert data["not_available_types"] == []
    det = next(d for d in data["detections"] if d["type"] == "building")
    assert det["confidence"] == 0.92
    assert det["source"] == "OpenStreetMap"
    road = next(d for d in data["detections"] if d["type"] == "road")
    assert road["area_sqm"] is None
    assert road["confidence"] == 0.9


def test_detect_unknown_type_422(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["ufo"]})
    assert res.status_code == 422


def test_detect_vision_only_types_not_available(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res = client.post(
        "/api/satvision/detect",
        json={"bbox": BBOX, "object_types": ["building", "water", "tree", "solar"]},
    )
    assert res.status_code == 200
    data = res.json()
    _track(data["snapshot_id"])
    assert data["stats"]["total"] == 1  # building only
    assert sorted(data["not_available_types"]) == ["solar", "tree", "water"]


def test_compare_identical_snapshots_zero_changes(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building"]})
    assert res.status_code == 200
    sid = _track(res.json()["snapshot_id"])
    cmp_res = client.post("/api/satvision/compare", json={"snapshot_id_a": sid, "snapshot_id_b": sid})
    assert cmp_res.status_code == 200
    body = cmp_res.json()
    assert body["summary"]["total_changes"] == 0
    assert body["summary"]["new_total"] == 0
    assert body["summary"]["removed_total"] == 0
    assert body["changes"] == []


def test_compare_added_removed_detected(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res_a = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building"]})
    assert res_a.status_code == 200
    sid_a = _track(res_a.json()["snapshot_id"])

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_two_buildings())
    res_b = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building"]})
    assert res_b.status_code == 200
    sid_b = _track(res_b.json()["snapshot_id"])

    cmp_res = client.post("/api/satvision/compare", json={"snapshot_id_a": sid_a, "snapshot_id_b": sid_b})
    assert cmp_res.status_code == 200
    body = cmp_res.json()
    assert body["summary"]["new_total"] == 1
    assert body["summary"]["new_buildings"] == 1
    assert body["summary"]["removed_total"] == 0
    assert any(c["change"] == "added" and c["id"] == "building-2" for c in body["changes"])

    rev = client.post("/api/satvision/compare", json={"snapshot_id_a": sid_b, "snapshot_id_b": sid_a})
    assert rev.status_code == 200
    rbody = rev.json()
    assert rbody["summary"]["removed_total"] == 1
    assert rbody["summary"]["removed_buildings"] == 1


def test_compare_missing_snapshot_404():
    res = client.post(
        "/api/satvision/compare",
        json={"snapshot_id_a": "does-not-exist-a", "snapshot_id_b": "does-not-exist-b"},
    )
    assert res.status_code == 404


def test_empty_geodata_empty_detections(monkeypatch):
    import satvision

    monkeypatch.setattr(
        satvision, "fetch_geodata", lambda *a, **k: {"buildings": [], "roads": [], "is_synthetic": False}
    )
    res = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building", "road"]})
    assert res.status_code == 200
    data = res.json()
    _track(data["snapshot_id"])
    assert data["detections"] == []
    assert data["is_synthetic"] is False
    assert data["stats"]["total"] == 0


def test_snapshots_list_endpoint(monkeypatch):
    import satvision

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    res = client.post("/api/satvision/detect", json={"bbox": BBOX, "object_types": ["building"]})
    assert res.status_code == 200
    sid = _track(res.json()["snapshot_id"])
    listed = client.get("/api/satvision/snapshots")
    assert listed.status_code == 200
    ids = [s["id"] for s in listed.json()["snapshots"]]
    assert sid in ids


def test_detect_hybrid_optical_satellite(monkeypatch):
    import satvision
    import numpy as np

    monkeypatch.setattr(satvision, "fetch_geodata", lambda *a, **k: _canned_one_building_one_road())
    # Mock synthetic optical satellite image with green vegetation and blue water
    fake_img = np.zeros((100, 100, 3), dtype=np.uint8)
    fake_img[10:30, 10:30] = [20, 180, 20]  # green vegetation
    fake_img[40:60, 40:60] = [20, 70, 150]  # water body
    monkeypatch.setattr(satvision, "_fetch_arcgis_satellite_raster", lambda bbox: fake_img)

    res = client.post(
        "/api/satvision/detect",
        json={
            "bbox": BBOX,
            "object_types": ["building", "road", "water", "tree", "solar"],
            "model": "hybrid",
        },
    )
    assert res.status_code == 200
    data = res.json()
    _track(data["snapshot_id"])
    assert data["not_available_types"] == []
    assert data["stats"]["total"] >= 2  # building + road + optical detections
    types = [d["type"] for d in data["detections"]]
    assert "building" in types
    assert "road" in types
    assert "tree" in types or "water" in types
