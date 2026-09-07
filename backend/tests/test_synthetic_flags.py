"""
DisasterLens — Synthetic Fallback Flag Tests (hermetic, no network)
====================================================================
Forces offline mode by monkeypatching requests to raise ConnectionError,
then asserts is_synthetic flags and synthetic source tagging.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests
from geodata.osm import fetch_geodata
from geodata.elevation import fetch_elevation_grid
from geodata.provenance import SYNTHETIC_DATA_NOTICE

# Unique bboxes (remote ocean / outback) to avoid hits in the local sqlite cache
SYNTH_BBOX = (-35.10, 138.50, -35.00, 138.60)
ELEV_BBOX = (-25.10, 133.50, -25.00, 133.60)
REAL_BBOX = (48.80, 2.20, 48.90, 2.35)

FEATURE_GROUPS = ("roads", "buildings", "hospitals", "shelters", "police", "fire_stations", "schools")


def _raise_offline(*args, **kwargs):
    raise ConnectionError("offline (test)")


def _assert_no_osm_source(data):
    for group in FEATURE_GROUPS:
        for feat in data.get(group, []):
            assert feat.get("source") != "OpenStreetMap", f"{group} feature claims OpenStreetMap source"
            raw_tags = feat.get("raw_tags") or {}
            assert raw_tags.get("source") != "OpenStreetMap", f"{group} raw_tags claim OpenStreetMap source"


def test_geodata_synthetic_flag_and_source(monkeypatch):
    monkeypatch.setattr(requests, "post", _raise_offline)
    monkeypatch.setattr(requests, "get", _raise_offline)
    monkeypatch.setattr("geodata.osm.get_cached_geodata", lambda *a, **k: None)
    data = fetch_geodata(*SYNTH_BBOX)
    assert data["is_synthetic"] is True
    _assert_no_osm_source(data)
    for group in FEATURE_GROUPS:
        for feat in data.get(group, []):
            assert feat.get("source") == "synthetic"


def test_geodata_cache_read_preserves_synthetic_flag(monkeypatch):
    """A cached synthetic payload must round-trip with is_synthetic preserved."""
    from db.spatial_store import save_cached_geodata
    save_cached_geodata(*SYNTH_BBOX, {"is_synthetic": True})
    monkeypatch.setattr(requests, "post", _raise_offline)
    monkeypatch.setattr(requests, "get", _raise_offline)
    data = fetch_geodata(*SYNTH_BBOX)  # served from cache written above
    assert data["is_synthetic"] is True
    _assert_no_osm_source(data)


def test_geodata_real_path_flag_false(monkeypatch):
    """Stubbed Overpass success must yield is_synthetic False (hermetic)."""
    class _FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"elements": []}

    monkeypatch.setattr(requests, "post", lambda *a, **k: _FakeResp())
    monkeypatch.setattr(requests, "get", _raise_offline)
    monkeypatch.setattr("geodata.osm.get_cached_geodata", lambda *a, **k: None)
    data = fetch_geodata(*REAL_BBOX)
    assert data["is_synthetic"] is False


def test_elevation_synthetic_flag(monkeypatch):
    monkeypatch.setattr(requests, "get", _raise_offline)
    monkeypatch.setattr("geodata.elevation.get_cached_elevation", lambda *a, **k: None)
    result = fetch_elevation_grid(*ELEV_BBOX)
    assert result["is_synthetic"] is True


def test_synthetic_data_notice_exists():
    assert isinstance(SYNTHETIC_DATA_NOTICE, str)
    assert len(SYNTHETIC_DATA_NOTICE) > 20


PARTIAL_BBOX = (48.90, 2.35, 49.00, 2.45)

_ROAD_ELEM = {
    "type": "way",
    "id": 101,
    "tags": {"highway": "primary", "name": "Rue Test"},
    "geometry": [{"lat": 48.95, "lon": 2.40}, {"lat": 48.96, "lon": 2.41}],
}


class _FakeResp:
    def __init__(self, elements):
        self._elements = elements

    def raise_for_status(self):
        pass

    def json(self):
        return {"elements": self._elements}


def test_geodata_partial_failure_keeps_real_roads(monkeypatch):
    """Roads query succeeds + buildings query fails → real roads, synthetic
    buildings, is_synthetic True with synthetic_parts == ['buildings']."""

    def _fake_post(url, data=None, headers=None, timeout=None):
        q = (data or {}).get("data", "")
        if '"highway"' in q or "['highway']" in q or '["highway"]' in q or "highway" in q:
            return _FakeResp([_ROAD_ELEM])
        raise ConnectionError("buildings offline (test)")

    monkeypatch.setattr(requests, "post", _fake_post)
    monkeypatch.setattr(requests, "get", _raise_offline)
    monkeypatch.setattr("geodata.osm.get_cached_geodata", lambda *a, **k: None)
    monkeypatch.setattr("geodata.osm._RETRY_BACKOFF_S", 0)
    monkeypatch.setattr("geodata.elevation.get_cached_elevation", lambda *a, **k: None)
    data = fetch_geodata(*PARTIAL_BBOX)
    assert data["is_synthetic"] is True
    assert data["synthetic_parts"] == ["buildings"]
    assert len(data["roads"]) == 1
    assert data["roads"][0].get("source") != "synthetic"
    assert len(data["buildings"]) > 0  # derived from real roads
    for b in data["buildings"]:
        assert b.get("source") == "synthetic"
    _assert_no_osm_source(data)
