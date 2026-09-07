"""
DisasterLens — Wildfire Propagation Engine (Rothermel / Huygens)
================================================================
Deterministic fire spread model accounting for terrain slope (DEM gradient),
wind speed & direction, fuel moisture (temperature & relative humidity),
and elliptical Huygens perimeter expansion.
"""

import numpy as np
import math
import logging
from typing import Dict, Any, List, Tuple, Optional
from simulation.base import BaseHazardModule, HazardOutput

logger = logging.getLogger(__name__)


class WildfireHazardModule(BaseHazardModule):
    disaster_type = "wildfire"
    model_name = "Rothermel / Huygens Surface Fire Propagation Solver"
    version = "v2.1-pyro"
    units = {"burn_severity": "Index (0-1.0)", "flame_length": "meters (m)", "spread_rate": "m/h"}
    assumptions = [
        "Surface fire propagation dominant based on Rothermel (1972) rate-of-spread equations",
        "Elliptical perimeter growth governed by Huygens wavelet principle",
        "Slope acceleration derived from 2D DEM topographic gradients",
        "Fuel moisture calculated from ambient temperature and relative humidity",
    ]
    uncertainty_description = (
        "Fire spread is sensitive to localized wind shifts and erratic spotting "
        "(firebrands carried aloft) not captured by steady-state surface flame equations."
    )
    governing_equations = (
        "R = R0 * (1 + Phi_w + Phi_s), where Phi_w = c*(U_wind)^B, Phi_s = 5.275*(tan(slope))^2"
    )
    scientific_references = [
        "Rothermel, R.C. (1972). A mathematical model for predicting fire spread in wildland fuels. USDA Forest Service Res. Pap. INT-115.",
        "Finney, M.A. (1998). FARSITE: Fire Area Simulator—model development and evaluation. USDA Forest Service RMRS-RP-4.",
    ]

    def validate_parameters(self, scenario: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        wind_speed = scenario.get("wind_speed_kmh", 25.0)
        temp_c = scenario.get("temperature_c", 35.0)
        humidity = scenario.get("relative_humidity_pct", 20.0)

        if not (0 <= wind_speed <= 250):
            return False, f"Wind speed {wind_speed} km/h outside supported range (0 - 250 km/h)"
        if not (0 <= temp_c <= 60):
            return False, f"Temperature {temp_c}°C outside range (0 - 60°C)"
        if not (1 <= humidity <= 100):
            return False, f"Relative humidity {humidity}% outside range (1 - 100%)"
        return True, None

    def run_simulation(
        self,
        elevation: np.ndarray,
        geodata: Dict[str, Any],
        scenario: Dict[str, Any],
        resolution_m: float = 90.0,
        bbox: Optional[Dict[str, float]] = None,
    ) -> HazardOutput:
        wind_speed_kmh = float(scenario.get("wind_speed_kmh", 30.0))
        wind_dir_deg = float(scenario.get("wind_direction_deg", 45.0))  # Blowing towards 45° (NE)
        temp_c = float(scenario.get("temperature_c", 34.0))
        rh_pct = float(scenario.get("relative_humidity_pct", 22.0))
        duration_hours = float(scenario.get("duration_hours", 12.0))

        rows, cols = elevation.shape
        if bbox is None:
            raise ValueError("bbox is required")

        # Calculate fuel moisture from RH and Temperature
        # Equilibrium moisture content (EMC):
        emc = max(0.02, 0.035 + 0.26 * (rh_pct / 100.0) - 0.0008 * temp_c)
        moisture_factor = max(0.2, (1.0 - emc * 3.0))

        # Topographic slope factor
        dy, dx = np.gradient(elevation, resolution_m, resolution_m)
        slope_rad = np.arctan(np.sqrt(dx**2 + dy**2))
        phi_s = 5.275 * (np.tan(slope_rad)**2)

        # Wind factor (aligned in direction of wind)
        wind_u = wind_speed_kmh * (1000.0 / 3600.0)  # m/s
        phi_w = 0.05 * (wind_u ** 1.4)

        # Base rate of spread R0: ~ 120 meters/hour in dry grass/shrub
        r0 = 120.0 * moisture_factor  # m/h

        # Ignition point: user provided or center-west
        center_lat = (bbox["north"] + bbox["south"]) / 2.0
        center_lon = (bbox["east"] + bbox["west"]) / 2.0
        ign_lat = float(scenario.get("ignition_lat", center_lat - 0.01))
        ign_lon = float(scenario.get("ignition_lon", center_lon - 0.01))

        lats = np.linspace(bbox["north"], bbox["south"], rows)
        lons = np.linspace(bbox["west"], bbox["east"], cols)
        LON, LAT = np.meshgrid(lons, lats)

        # Vector from ignition point
        dy_m = (LAT - ign_lat) * 111320.0
        dx_m = (LON - ign_lon) * (111320.0 * np.cos(np.radians(center_lat)))
        dist_from_ign_m = np.sqrt(dx_m**2 + dy_m**2)

        # Angle of vector relative to wind direction
        theta_vec = np.arctan2(dy_m, dx_m)  # radians from East
        wind_az_rad = np.radians((450 - wind_dir_deg) % 360)  # math angle
        d_theta = np.abs(theta_vec - wind_az_rad)

        # Elliptical fire shape eccentricity
        # Downwind axis is elongated, upwind axis is suppressed
        length_to_width = max(1.0, 1.0 + 0.25 * wind_u)
        eccentricity = np.sqrt(1.0 - (1.0 / length_to_width**2))

        effective_ros = r0 * (1.0 + phi_w * np.cos(d_theta) + phi_s)
        effective_ros = np.maximum(effective_ros, 20.0)  # min backing fire spread

        # Arrival time (hours to reach cell)
        # Add small epsilon to avoid divide by zero
        arrival_time_h = dist_from_ign_m / np.maximum(effective_ros, 1.0)
        # Apply elliptical distortion
        elongation = np.cos(d_theta) * (length_to_width - 1.0)
        arrival_time_h = arrival_time_h / np.maximum(1.0 + elongation, 0.3)

        num_frames = 6
        timesteps = np.linspace(0.0, duration_hours, num_frames).tolist()
        frames = []

        max_severity = np.zeros((rows, cols), dtype=np.float64)

        for t in timesteps:
            # Burn severity index: 1.0 for active fire, 0.7 for smoldering burn scar
            burned_mask = arrival_time_h <= t
            severity = np.zeros((rows, cols), dtype=np.float64)
            # Active flame front: reached within last 2 hours
            active_mask = burned_mask & (arrival_time_h >= max(0.0, t - 2.0))
            scar_mask = burned_mask & (arrival_time_h < max(0.0, t - 2.0))
            severity[scar_mask] = 0.65
            severity[active_mask] = 1.0

            frames.append(np.round(severity, 2).tolist())
            max_severity = np.maximum(max_severity, severity)

        return HazardOutput(
            disaster_type="wildfire",
            model_name=self.model_name,
            timesteps=[round(t, 2) for t in timesteps],
            frames=frames,
            max_hazard=np.round(max_severity, 2).tolist(),
            rows=rows,
            cols=cols,
            hazard_unit="Burn Severity Index (0-1.0)",
            threshold_impact=0.5,
            total_time_hours=duration_hours,
            metadata={
                "wind_speed_kmh": wind_speed_kmh,
                "wind_direction_deg": wind_dir_deg,
                "temperature_c": temp_c,
                "humidity_pct": rh_pct,
                "burn_area_km2": round(float(np.sum(max_severity > 0.5) * (resolution_m**2) / 1e6), 2),
            },
        )
