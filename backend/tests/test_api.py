"""
DisasterLens — FastAPI Endpoints & Integration Tests
====================================================
Tests health check, disaster modules, presets, geodata, simulation,
routing, and provenance endpoints.
"""

from fastapi.testclient import TestClient
from main import app
from geodata.cached_scenarios import MUMBAI_GS_WARD_BBOX

client = TestClient(app)


def test_health_check():
    res = client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert "flood" in data["supported_disasters"]


def test_list_disasters():
    res = client.get("/api/disasters")
    assert res.status_code == 200
    data = res.json()
    types = [d["type"] for d in data["disasters"]]
    assert "flood" in types
    assert "earthquake" in types
    assert "wildfire" in types
    assert "landslide" in types
    assert "cyclone" not in types  # temporarily unsupported via API


def test_presets():
    res = client.get("/api/scenarios/presets")
    assert res.status_code == 200
    data = res.json()
    assert len(data["presets"]) >= 3


def test_provenance():
    res = client.get("/api/provenance?disaster_type=flood")
    assert res.status_code == 200
    data = res.json()
    assert "data_sources" in data
    assert "disaster_model" in data
    assert len(data["data_sources"]) >= 4


def test_simulate_mumbai_flood():
    payload = {
        "bbox": MUMBAI_GS_WARD_BBOX,
        "disaster_type": "flood",
        "location_name": "G/S Ward, Mumbai, Maharashtra",
        "rainfall_mm": 150.0,
        "duration_hours": 12.0,
        "sea_level_surge_m": 2.0,
    }
    res = client.post("/api/simulate", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert "simulation" in data
    assert "impact" in data
    assert "evacuation_routes" in data
    assert data["impact"]["flooded_area_km2"] > 0
    assert data["impact"]["road_status"]["total"] > 0


if __name__ == "__main__":
    test_health_check()
    test_list_disasters()
    test_presets()
    test_provenance()
    test_simulate_mumbai_flood()
    print("All API integration tests PASSED successfully!")
