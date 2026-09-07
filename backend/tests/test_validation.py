"""
DisasterLens — Request Validation Contract Tests (hermetic, no network)
========================================================================
CONTRACT for the core worker (owns main.py): BoundingBox and disaster_type
inputs must be rejected with 422 BEFORE any network/simulation work.
These tests are hermetic because FastAPI request validation runs before
any downstream fetch or model execution.

Required validators in main.py:
- BoundingBox: south < north, west < east, lat in [-90, 90], lon in [-180, 180],
  and total area below an oversized cap.
- SimulationRequest.disaster_type: one of flood, earthquake, wildfire,
  landslide, cyclone (anything else -> 422).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from main import app
from geodata.cached_scenarios import MUMBAI_GS_WARD_BBOX

client = TestClient(app)


def _simulate_payload(**overrides):
    payload = {
        "bbox": dict(MUMBAI_GS_WARD_BBOX),
        "disaster_type": "flood",
        "location_name": "Validation Test Area",
        "rainfall_mm": 150.0,
        "duration_hours": 12.0,
        "sea_level_surge_m": 0.0,
    }
    payload.update(overrides)
    return payload


def test_bbox_south_north_rejected():
    """south > north must be rejected with 422."""
    bad_bbox = dict(MUMBAI_GS_WARD_BBOX)
    bad_bbox["south"], bad_bbox["north"] = bad_bbox["north"], bad_bbox["south"]
    res = client.post("/api/simulate", json=_simulate_payload(bbox=bad_bbox))
    assert res.status_code == 422


def test_bbox_lat_out_of_range_rejected():
    """Latitude outside [-90, 90] must be rejected with 422."""
    bad_bbox = dict(MUMBAI_GS_WARD_BBOX)
    bad_bbox["north"] = 95.0
    res = client.post("/api/simulate", json=_simulate_payload(bbox=bad_bbox))
    assert res.status_code == 422


def test_bbox_oversized_area_rejected():
    """A globe-spanning bbox must be rejected with 422 as oversized."""
    huge_bbox = {"south": -90.0, "west": -180.0, "north": 90.0, "east": 180.0}
    res = client.post("/api/simulate", json=_simulate_payload(bbox=huge_bbox))
    assert res.status_code == 422


def test_invalid_disaster_type_rejected():
    """An unknown disaster_type must be rejected with 422."""
    res = client.post("/api/simulate", json=_simulate_payload(disaster_type="tornado"))
    assert res.status_code == 422
