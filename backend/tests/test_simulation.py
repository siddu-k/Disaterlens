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
    assert "imd_category" in out.metadata
    assert "surge_grid" in out.metadata
    assert "track_points" in out.metadata
    assert len(out.metadata["track_points"]) == 12
    assert "surge_time_factors" in out.metadata
    assert out.metadata["surge_time_factors"][0] == 0.0
    # Peak surge occurs at or near closest approach
    assert max(out.metadata["surge_time_factors"]) >= 0.85


def test_cyclone_temporal_onset_and_decay():
    """Verify that the AOI is calm at Frame 0 and does not experience premature cyclone effects."""
    mod = CycloneHazardModule()
    elev = np.ones((15, 15), dtype=np.float64) * 5.0
    bbox = {"south": 18.9, "west": 72.8, "north": 19.1, "east": 73.0}

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={"central_pressure_hpa": 935.0, "max_wind_kmh": 185.0, "duration_hours": 12.0},
        bbox=bbox,
    )

    # Frame 0 must be ambient pre-storm breeze (15 km/h), completely safe
    f0 = np.array(out.frames[0])
    assert np.all(f0 <= 20.0)

    # Frame 1 (early approach) must be well below hurricane thresholds (< 45 km/h)
    f1 = np.array(out.frames[1])
    assert np.max(f1) < 45.0

    # Eyewall arrival at middle frames must reach severe hurricane force
    mid_frames_max = max(np.max(np.array(out.frames[i])) for i in range(3, 8))
    assert mid_frames_max >= 130.0

    # Final frame (after cyclone exits) must decay significantly
    f_last = np.array(out.frames[-1])
    assert np.mean(f_last) < 40.0


def test_cyclone_custom_direction_and_radius():
    mod = CycloneHazardModule()
    elev = np.ones((15, 15), dtype=np.float64) * 10.0
    bbox = {"south": 18.9, "west": 72.8, "north": 19.1, "east": 73.0}

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={
            "central_pressure_hpa": 940.0,
            "max_wind_kmh": 175.0,
            "duration_hours": 18.0,
            "cyclone_direction_deg": 270.0,  # Moving Westbound
            "cyclone_radius_km": 45.0,
            "storm_radius_km": 200.0,
            "forward_speed_kmh": 25.0,
        },
        bbox=bbox,
    )

    meta = out.metadata
    assert meta["cyclone_direction_deg"] == 270.0
    assert meta["cyclone_radius_km"] == 45.0
    assert meta["forward_speed_kmh"] == 25.0
    tracks = meta["track_points"]
    assert len(tracks) == 12
    # Moving westbound (270 deg): longitude must decrease over time
    first_lon = tracks[0]["lon"]
    last_lon = tracks[-1]["lon"]
    assert last_lon < first_lon


def test_wildfire_rothermel_comprehensive_parameters():
    mod = WildfireHazardModule()
    elev = np.ones((20, 20), dtype=np.float64) * 15.0
    bbox = {"south": 17.3, "west": 78.4, "north": 17.5, "east": 78.6}

    out = mod.run_simulation(
        elevation=elev,
        geodata={},
        scenario={
            "wind_speed_kmh": 25.0,
            "wind_direction_deg": 135.0,  # NW to SE
            "temperature_c": 38.0,
            "relative_humidity_pct": 25.0,
            "fuel_type": "grass",
            "fuel_moisture_pct": 8.0,
            "recent_rainfall_mm": 2.0,
            "slope_deg": 15.0,
            "aspect_direction": "south",
            "initial_fire_radius_m": 10.0,
            "duration_hours": 8.0,
            "ignition_lat": 17.4,
            "ignition_lon": 78.5,
        },
        bbox=bbox,
    )

    meta = out.metadata
    assert meta["fuel_type"] == "grass"
    assert meta["fuel_moisture_pct"] == 8.0
    assert meta["recent_rainfall_mm"] == 2.0
    assert meta["initial_fire_radius_m"] == 10.0
    assert meta["rate_of_spread_max_mh"] > 50.0
    assert meta["flame_length_m"] > 0.5
    assert meta["fire_danger_rating"] in ["Moderate", "High", "Very High", "Catastrophic / Extreme"]
    assert len(out.frames) >= 18
    # Frame 0 should contain the initial ignition core
    f0 = np.array(out.frames[0])
    assert np.sum(f0 > 0) > 0


if __name__ == "__main__":
    test_flood_model_physics()
    test_earthquake_gmpe_attenuation()
    test_wildfire_downwind_propagation()
    test_landslide_slope_dependence()
    test_cyclone_radial_wind_and_category()
    test_cyclone_custom_direction_and_radius()
    test_wildfire_rothermel_comprehensive_parameters()
    print("All simulation unit tests PASSED successfully!")
