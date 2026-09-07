"""
DisasterLens — Per-Hazard Physical Impact Tests (hermetic, no network)
=======================================================================
Synthetic numpy grids + tiny geodata dicts only. Verifies per-disaster
building damage states, road refinements, population add-ons, facility
add-ons, and that legacy response keys are preserved.
"""

import numpy as np

from analysis.impact import analyze_impact

BBOX = {"south": 19.0, "west": 72.8, "north": 19.1, "east": 72.9}
ROWS, COLS = 10, 10


def _cell_latlon(r, c):
    lat_r = BBOX["north"] - BBOX["south"]
    lon_r = BBOX["east"] - BBOX["west"]
    return (
        BBOX["north"] - (r + 0.5) / ROWS * lat_r,
        BBOX["west"] + (c + 0.5) / COLS * lon_r,
    )


def _building_at(r, c, **kw):
    lat, lon = _cell_latlon(r, c)
    b = {"id": 1, "centroid": {"lat": lat, "lon": lon}, "area_sqm": 300}
    b.update(kw)
    return b


def _road_through(r, c, **kw):
    lat, lon = _cell_latlon(r, c)
    d = 0.001
    road = {
        "id": 1,
        "name": "Test Road",
        "type": "residential",
        "coords": [[lon - d, lat], [lon + d, lat]],
        "length_m": 500.0,
    }
    road.update(kw)
    return road


def _geodata(roads, buildings, hospitals=None):
    return {
        "roads": roads,
        "buildings": buildings,
        "hospitals": hospitals or [],
        "shelters": [],
    }


def _sim(grid, disaster_type, **kw):
    s = {"max_hazard": np.array(grid, dtype=np.float64), "rows": ROWS, "cols": COLS,
         "disaster_type": disaster_type}
    s.update(kw)
    return s


def test_earthquake_damage_worsens_and_benign_closes_nothing():
    ratios = []
    states = []
    for mmi in (5.0, 7.0, 8.5):
        grid = np.full((ROWS, COLS), mmi)
        impact = analyze_impact(
            _sim(grid, "earthquake"),
            _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
            BBOX, grid_resolution=90.0,
        )
        b = impact["buildings"][0]
        assert "damage_state" in b and "damage_ratio" in b
        ratios.append(b["damage_ratio"])
        states.append(b["damage_state"])
    assert ratios[0] <= ratios[1] <= ratios[2]
    assert ratios[0] == 0.0
    assert states[0] == "None"
    assert states[2] == "Complete"

    benign = analyze_impact(
        _sim(np.full((ROWS, COLS), 5.0), "earthquake"),
        _geodata([_road_through(2, 2)], [_building_at(2, 2)]),
        BBOX, grid_resolution=90.0,
    )
    assert benign["road_status"]["closed"] == 0
    assert benign["estimated_fatalities"] == 0
    assert benign["estimated_injuries"] == 0


def test_earthquake_bridge_and_tunnel_closure():
    grid = np.full((ROWS, COLS), 7.2)
    hot_bridge = analyze_impact(
        _sim(grid, "earthquake"),
        _geodata([_road_through(5, 5, bridge=True)], [_building_at(0, 0)]),
        BBOX, grid_resolution=90.0,
    )
    road = hot_bridge["roads"][0]
    assert road["status"] == "closed"
    assert "Bridge" in road["closure_reason"]

    plain = analyze_impact(
        _sim(grid, "earthquake"),
        _geodata([_road_through(5, 5)], [_building_at(0, 0)]),
        BBOX, grid_resolution=90.0,
    )
    assert plain["roads"][0]["status"] != "closed"

    grid_t = np.full((ROWS, COLS), 7.6)
    tun = analyze_impact(
        _sim(grid_t, "earthquake"),
        _geodata([_road_through(5, 5, tunnel=True)], [_building_at(0, 0)]),
        BBOX, grid_resolution=90.0,
    )
    assert tun["roads"][0]["status"] == "closed"
    assert "Tunnel" in tun["roads"][0]["closure_reason"]


def test_wildfire_benign_closes_nothing_and_smoke_restricts():
    benign = analyze_impact(
        _sim(np.full((ROWS, COLS), 0.1), "wildfire"),
        _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    assert benign["road_status"]["closed"] == 0
    assert benign["road_status"]["restricted"] == 0

    grid = np.zeros((ROWS, COLS))
    grid[5, 5] = 1.0
    # Neighbour cells within Manhattan-2 get low severity (smoke zone).
    grid[5, 6] = 0.4
    grid[4, 5] = 0.4
    impact = analyze_impact(
        _sim(grid, "wildfire"),
        _geodata([_road_through(5, 6)], [_building_at(5, 6)]),
        BBOX, grid_resolution=90.0,
    )
    road = impact["roads"][0]
    assert road["status"] == "restricted"
    assert "Smoke" in road["closure_reason"]


def test_flood_damage_ratio_bounds_and_displaced():
    shallow = analyze_impact(
        _sim(np.full((ROWS, COLS), 0.2), "flood"),
        _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    r = shallow["buildings"][0]["damage_ratio"]
    assert 0.0 <= r <= 0.95
    assert shallow["estimated_displaced"] == 0

    grid = np.zeros((ROWS, COLS))
    grid[:, :] = 0.1
    grid[3:6, 3:6] = 1.5  # deep cells
    deep = analyze_impact(
        _sim(grid, "flood"),
        _geodata([_road_through(0, 0)], [_building_at(4, 4)]),
        BBOX, grid_resolution=90.0,
    )
    r2 = deep["buildings"][0]["damage_ratio"]
    assert 0.0 <= r2 <= 0.95
    assert deep["buildings"][0]["damage_state"] in ("Major", "Moderate", "Destroyed")
    assert deep["estimated_displaced"] > 0


def test_cyclone_band_states():
    expected = {80: "None", 100: "Minor", 130: "Moderate", 160: "Extensive", 200: "Complete"}
    for wind, state in expected.items():
        impact = analyze_impact(
            _sim(np.full((ROWS, COLS), float(wind)), "cyclone"),
            _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
            BBOX, grid_resolution=90.0,
        )
        assert impact["buildings"][0]["damage_state"] == state


def test_landslide_buried_flag():
    hot = analyze_impact(
        _sim(np.full((ROWS, COLS), 0.8), "landslide"),
        _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    assert hot["buildings"][0]["damage_state"] == "Buried"
    assert hot["buildings"][0]["damage_ratio"] == 1.0
    benign = analyze_impact(
        _sim(np.full((ROWS, COLS), 0.1), "landslide"),
        _geodata([_road_through(5, 5)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    assert benign["buildings"][0]["damage_state"] == "Unaffected"
    assert benign["population_at_risk"] == 0


def test_casualties_scale_monotonically():
    cold = analyze_impact(
        _sim(np.full((ROWS, COLS), 7.0), "earthquake"),
        _geodata([_road_through(1, 1)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    hot = analyze_impact(
        _sim(np.full((ROWS, COLS), 9.6), "earthquake"),
        _geodata([_road_through(1, 1)], [_building_at(5, 5)]),
        BBOX, grid_resolution=90.0,
    )
    assert hot["estimated_fatalities"] > cold["estimated_fatalities"]
    assert hot["estimated_injuries"] >= hot["estimated_fatalities"]


def test_existing_keys_preserved_and_facilities():
    lat, lon = _cell_latlon(5, 5)
    facilities = [{"id": 9, "name": "H", "type": "hospital", "lat": lat, "lon": lon}]
    impact = analyze_impact(
        _sim(np.full((ROWS, COLS), 7.0), "earthquake"),
        _geodata([_road_through(1, 1)], [_building_at(5, 5)], hospitals=facilities),
        BBOX, grid_resolution=90.0,
    )
    assert "flooded_area_km2" in impact
    assert "road_status" in impact
    assert {"total", "affected", "safe"} <= set(impact["buildings_summary"].keys())
    assert "buildings_destroyed" in impact["buildings_summary"]
    assert impact["facilities"][0]["functionality"] == "degraded"

    grid = np.zeros((ROWS, COLS))
    grid[5, 5] = 1.0
    flat, flon = _cell_latlon(5, 7)
    wfac = [{"id": 9, "name": "H", "type": "hospital", "lat": flat, "lon": flon}]
    wimpact = analyze_impact(
        _sim(grid, "wildfire"),
        _geodata([_road_through(0, 0)], [_building_at(0, 0)], hospitals=wfac),
        BBOX, grid_resolution=90.0,
    )
    assert wimpact["facilities"][0]["smoke_risk"] is True
    assert wimpact["population_smoke_exposed"] > 0
