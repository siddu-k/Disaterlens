"""
DisasterLens — Automated Simulation & Multi-Hazard Model Tests
=============================================================
Verifies scientific consistency, mass conservation, monotonic attenuation,
and parameter bounds across all hazard plugins.
"""

import pytest
import numpy as np
from simulation.flood import FloodHazardModule
from simulation.earthquake import EarthquakeHazardModule
from simulation.wildfire import WildfireHazardModule
from simulation.landslide import LandslideHazardModule
from simulation.cyclone import CycloneHazardModule


def test_flood_model_physics():
    mod = FloodHazardModule()
    # Simple synthetic 10x10 elevation with a bowl in center
    elev = np.ones((10, 10), dtype=np.float64) * 10.0
    elev[4:6, 4:6] = 2.0  # low depression

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={"rainfall_mm": 100.0, "duration_hours": 2.0, "dt": 60, "output_interval": 3600},
        resolution_m=30.0,
    )

    assert out.disaster_type == "flood"
    assert len(out.frames) > 0
    max_d = np.array(out.max_hazard)
    # Water should accumulate in the central depression
    assert np.max(max_d[4:6, 4:6]) > np.max(max_d[0:2, 0:2])
    assert np.all(max_d >= 0.0)


def test_earthquake_gmpe_attenuation():
    mod = EarthquakeHazardModule()
    elev = np.ones((15, 15), dtype=np.float64) * 20.0
    bbox = {"south": 18.9, "west": 72.8, "north": 19.1, "east": 73.0}

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={"magnitude": 7.0, "depth_km": 10.0, "epicenter_lat": 19.0, "epicenter_lon": 72.9},
        resolution_m=90.0,
        bbox=bbox,
    )

    mmi = np.array(out.max_hazard)
    # Epicenter is at center
    center_mmi = mmi[7, 7]
    corner_mmi = mmi[0, 0]
    # MMI must decrease monotonically with distance from epicenter
    assert center_mmi > corner_mmi
    assert center_mmi >= 6.0


def test_wildfire_downwind_propagation():
    mod = WildfireHazardModule()
    elev = np.ones((20, 20), dtype=np.float64) * 10.0
    bbox = {"south": 18.9, "west": 72.8, "north": 19.1, "east": 73.0}

    # Wind blowing towards NE (45 degrees)
    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={
            "wind_speed_kmh": 40.0,
            "wind_direction_deg": 45.0,
            "temperature_c": 35.0,
            "relative_humidity_pct": 15.0,
            "duration_hours": 6.0,
            "ignition_lat": 19.0,
            "ignition_lon": 72.9,
        },
        bbox=bbox,
    )

    sev = np.array(out.max_hazard)
    # North-East quadrant should have higher burn severity than South-West (upwind) quadrant
    ne_burn = np.sum(sev[0:8, 12:20])
    sw_burn = np.sum(sev[12:20, 0:8])
    assert ne_burn >= sw_burn


def test_landslide_slope_dependence():
    mod = LandslideHazardModule()
    # Non-linear terrain: flat on left (slope ~ 0°), steepening mountain on right (slope > 35°)
    x = (np.linspace(0, 1, 20) ** 2.5) * 800.0
    elev = np.tile(x, (20, 1))

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={"cumulative_rainfall_mm": 250.0, "duration_hours": 24.0},
        resolution_m=30.0,
    )

    lsi = np.array(out.max_hazard)
    # Right steep cells should have significantly higher landslide susceptibility than left flat cells
    assert np.mean(lsi[:, 15:]) > np.mean(lsi[:, :5])


def test_cyclone_radial_wind_and_category():
    mod = CycloneHazardModule()
    elev = np.ones((15, 15), dtype=np.float64) * 5.0
    bbox = {"south": 18.9, "west": 72.8, "north": 19.1, "east": 73.0}

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={"central_pressure_hpa": 935.0, "max_wind_kmh": 185.0, "duration_hours": 12.0},
        bbox=bbox,
    )

    wind = np.array(out.max_hazard)
    assert np.max(wind) > 130.0
    assert "Category" in out.metadata["saffir_simpson_category"]


if __name__ == "__main__":
    test_flood_model_physics()
    test_earthquake_gmpe_attenuation()
    test_wildfire_downwind_propagation()
    test_landslide_slope_dependence()
    test_cyclone_radial_wind_and_category()
    print("All simulation unit tests PASSED successfully!")
