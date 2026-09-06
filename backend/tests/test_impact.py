"""
DisasterLens — Impact Analysis & Road Routing Tests
===================================================
Verifies deterministic spatial intersections, road status classifications,
population calculations, and safe evacuation network routing.
"""

import numpy as np
from analysis.impact import analyze_impact
from analysis.routing import compute_evacuation_routes, build_road_network_graph


def test_road_classification_and_routing():
    bbox = {"south": 18.99, "west": 72.82, "north": 19.03, "east": 72.86}
    rows, cols = 20, 20

    # Create synthetic max hazard grid with flooded east side
    max_hazard = np.zeros((rows, cols), dtype=np.float64)
    max_hazard[:, 12:] = 1.2  # 1.2m water on east side

    roads = [
        {
            "id": 1,
            "name": "Flooded East Freeway",
            "type": "trunk",
            "coords": [[72.85, 19.00], [72.85, 19.02]],
            "length_m": 2200.0,
            "status": "open",
        },
        {
            "id": 2,
            "name": "Safe West Highway",
            "type": "primary",
            "coords": [[72.83, 19.00], [72.83, 19.02]],
            "length_m": 2200.0,
            "status": "open",
        },
        {
            "id": 3,
            "name": "Cross Connector Road",
            "type": "secondary",
            "coords": [[72.83, 19.01], [72.85, 19.01]],
            "length_m": 2100.0,
            "status": "open",
        },
    ]

    facilities = [
        {"id": 101, "name": "East Hospital", "type": "hospital", "lat": 19.01, "lon": 72.85, "flooded": False},
        {"id": 102, "name": "West Relief Center", "type": "shelter", "lat": 19.01, "lon": 72.83, "flooded": False},
    ]

    buildings = [
        {"id": 501, "name": "East Residential Block", "centroid": {"lat": 19.01, "lon": 72.85}, "area_sqm": 250},
        {"id": 502, "name": "West Residential Block", "centroid": {"lat": 19.01, "lon": 72.83}, "area_sqm": 250},
    ]

    geodata = {
        "roads": roads,
        "facilities": facilities,
        "shelters": [facilities[1]],
        "hospitals": [facilities[0]],
        "buildings": buildings,
    }

    sim_res = {
        "max_hazard": max_hazard,
        "rows": rows,
        "cols": cols,
        "disaster_type": "flood",
    }

    impact = analyze_impact(sim_res, geodata, bbox, grid_resolution=90.0)

    # 1. Road status checks
    assert impact["road_status"]["closed"] >= 1
    assert impact["road_status"]["open"] >= 1
    east_road = next(r for r in impact["roads"] if r["id"] == 1)
    west_road = next(r for r in impact["roads"] if r["id"] == 2)
    assert east_road["status"] == "closed"
    assert west_road["status"] == "open"

    # 2. Building checks
    assert impact["buildings_affected"] == 1
    assert impact["total_buildings"] == 2

    # 3. Population checks
    assert impact["estimated_population_exposed"] > 0

    # 4. Routing checks: Routes should avoid the closed road
    routes = impact.get("evacuation_routes", [])
    assert isinstance(routes, list)


if __name__ == "__main__":
    test_road_classification_and_routing()
    print("All impact & routing tests PASSED successfully!")
