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
        wind_speed_kmh = float(scenario.get("wind_speed_kmh", 25.0))
        wind_dir_deg = float(scenario.get("wind_direction_deg", 135.0)) % 360.0  # Wind heading (blowing towards)
        temp_c = float(scenario.get("temperature_c", 38.0))
        rh_pct = float(scenario.get("relative_humidity_pct", 25.0))
        duration_hours = float(scenario.get("duration_hours", 12.0))
        recent_rainfall_mm = float(scenario.get("recent_rainfall_mm", 2.0))
        initial_radius_m = float(scenario.get("initial_fire_radius_m", 10.0))

        rows, cols = elevation.shape
        if bbox is None:
            raise ValueError("bbox is required")

        center_lat = (bbox["north"] + bbox["south"]) / 2.0
        center_lon = (bbox["east"] + bbox["west"]) / 2.0
        lat_span = max(0.0001, bbox["north"] - bbox["south"])
        lon_span = max(0.0001, bbox["east"] - bbox["west"])

        # 1. Automated 2D DEM Topography & Slope Gradient Analysis
        # Per-cell spatial gradients in meters
        dy_dem, dx_dem = np.gradient(elevation, resolution_m, resolution_m)
        cell_slope_rad = np.arctan(np.sqrt(dx_dem**2 + dy_dem**2))
        cell_slope_deg = np.degrees(cell_slope_rad)
        mean_slope_deg = round(float(np.mean(cell_slope_deg)), 1)
        max_slope_deg = round(float(np.max(cell_slope_deg)), 1)

        # Per-cell Solar Aspect derived directly from DEM gradient vector (steepest descent/ascent)
        cell_aspect_rad = np.arctan2(-dx_dem, dy_dem)
        cell_aspect_deg = (np.degrees(cell_aspect_rad) + 360.0) % 360.0
        mean_aspect_deg = round(float(np.mean(cell_aspect_deg)), 1)
        if 135.0 <= mean_aspect_deg <= 225.0:
            dominant_aspect = "south"
        elif 225.0 < mean_aspect_deg <= 315.0:
            dominant_aspect = "west"
        elif 45.0 <= mean_aspect_deg < 135.0:
            dominant_aspect = "east"
        else:
            dominant_aspect = "north"

        # Aspect solar drying factor per cell (South/West slopes receive higher irradiance)
        # Peak solar heating around 180° South (+18%), shaded slopes North (-10%)
        aspect_solar_grid = 1.0 + 0.18 * np.sin(np.radians(cell_aspect_deg - 45.0))

        # 2. Automated Fuel & Vegetation Classification from DEM Relief & Landcover
        user_fuel = scenario.get("fuel_type")
        if not user_fuel or str(user_fuel).lower() in ["auto", "default", ""]:
            # Auto-infer dominant fuel model from topographic slope and elevation relief
            if mean_slope_deg > 16.0:
                fuel_type = "forest"
            elif mean_slope_deg > 8.0:
                fuel_type = "shrub"
            else:
                fuel_type = "grass"
            fuel_auto_detected = True
        else:
            fuel_type = str(user_fuel).lower()
            fuel_auto_detected = False

        fuel_params = {
            "grass": {"r0": 210.0, "flame_mult": 1.25, "extinction_moist": 22.0, "name": "Grass / Savanna (Model 1)"},
            "shrub": {"r0": 140.0, "flame_mult": 1.75, "extinction_moist": 28.0, "name": "Shrub / Chaparral (Model 4)"},
            "forest": {"r0": 65.0, "flame_mult": 2.20, "extinction_moist": 30.0, "name": "Dense Forest / Timber (Model 8/10)"},
            "agriculture": {"r0": 105.0, "flame_mult": 1.15, "extinction_moist": 20.0, "name": "Agricultural Crop Residue (Model 3)"},
        }
        f_spec = fuel_params.get(fuel_type, fuel_params["grass"])
        r0_base = f_spec["r0"]
        ext_moist = f_spec["extinction_moist"]

        # 3. Dynamic Equilibrium Fuel Moisture Calculation
        # Auto-compute natural fuel moisture from atmospheric temperature, relative humidity, and rainfall
        user_moist = scenario.get("fuel_moisture_pct")
        if user_moist is None or str(user_moist).lower() in ["auto", "none", ""]:
            rh_emc = max(2.0, 3.5 + 0.24 * rh_pct - 0.08 * temp_c)
            fuel_moisture_pct = round(max(3.0, min(ext_moist, rh_emc + min(10.0, recent_rainfall_mm * 0.6))), 1)
        else:
            fuel_moisture_pct = float(user_moist)

        rain_dampening = min(12.0, recent_rainfall_mm * 0.75)
        effective_moist = max(2.0, min(ext_moist + 5.0, fuel_moisture_pct + rain_dampening * 0.4))
        r_m = effective_moist / ext_moist
        if r_m >= 1.0:
            eta_m_base = 0.05
        else:
            eta_m_base = max(0.08, 1.0 - 2.59 * r_m + 5.11 * (r_m ** 2) - 3.52 * (r_m ** 3))

        # 4. Wind Vector Calculations & Elliptical Geometry (Rothermel 1972 / Catchpole 1992)
        wind_u_ms = wind_speed_kmh * (1000.0 / 3600.0)
        # Math angle in radians where wind is blowing towards (0 = East, pi/2 = North)
        wind_math_rad = math.radians((450 - wind_dir_deg) % 360)

        # Length-to-breadth ratio based on wind speed (Alexander 1985 / Catchpole 1992)
        # Moderate wind yields LB ~ 2.5; strong wind (50+ km/h) yields LB ~ 4.2
        lb = max(1.15, min(5.5, 1.0 + 0.065 * wind_speed_kmh))
        eccentricity = math.sqrt(max(0.0, 1.0 - (1.0 / (lb ** 2))))
        phi_w = 0.045 * (wind_u_ms ** 1.35)

        # 5. Precise Ignition Point Setup
        raw_ign_lat = scenario.get("ignition_lat")
        raw_ign_lon = scenario.get("ignition_lon")
        if raw_ign_lat is not None and bbox["south"] <= float(raw_ign_lat) <= bbox["north"]:
            ign_lat = float(raw_ign_lat)
        else:
            ign_lat = center_lat
        if raw_ign_lon is not None and bbox["west"] <= float(raw_ign_lon) <= bbox["east"]:
            ign_lon = float(raw_ign_lon)
        else:
            ign_lon = center_lon

        ign_u = (ign_lon - bbox["west"]) / lon_span
        ign_v = (bbox["north"] - ign_lat) / lat_span
        ign_r = int(np.clip(round(ign_v * (rows - 1)), 0, rows - 1))
        ign_c = int(np.clip(round(ign_u * (cols - 1)), 0, cols - 1))
        ignition_slope_deg = round(float(cell_slope_deg[ign_r, ign_c]), 1)

        lats = np.linspace(bbox["north"], bbox["south"], rows)
        lons = np.linspace(bbox["west"], bbox["east"], cols)
        LON, LAT = np.meshgrid(lons, lats)

        # Distance from ignition point in meters
        dy_m = (LAT - ign_lat) * 111320.0
        dx_m = (LON - ign_lon) * (111320.0 * math.cos(math.radians(center_lat)))
        dist_from_ign_m = np.sqrt(dx_m**2 + dy_m**2)

        # 6. Continuous Elliptical Wavefront Propagation (Fast Marching / Dijkstra Solver)
        # Guarantees the fire starts strictly at the ignition point and expands continuously outward
        import heapq

        arrival_time_h = np.full((rows, cols), np.inf, dtype=np.float64)
        pq: List[Tuple[float, int, int]] = []
        wind_drive_sum = 0.0
        slope_drive_sum = 0.0
        drive_steps = 0

        # Seed the ignition core
        init_cell_radius = max(initial_radius_m, resolution_m * 0.6)
        init_mask = dist_from_ign_m <= init_cell_radius
        if not np.any(init_mask):
            arrival_time_h[ign_r, ign_c] = 0.0
            heapq.heappush(pq, (0.0, ign_r, ign_c))
        else:
            for r_idx, c_idx in np.argwhere(init_mask):
                arrival_time_h[r_idx, c_idx] = 0.0
                heapq.heappush(pq, (0.0, int(r_idx), int(c_idx)))

        # Precompute per-cell fuel rate of spread multipliers
        cell_r0 = np.full((rows, cols), r0_base, dtype=np.float64)
        if fuel_auto_detected:
            cell_r0[cell_slope_deg > 16.0] = fuel_params["forest"]["r0"]
            cell_r0[(cell_slope_deg >= 8.0) & (cell_slope_deg <= 16.0)] = fuel_params["shrub"]["r0"]
            cell_r0[cell_slope_deg < 8.0] = fuel_params["grass"]["r0"]

        # 8-neighbor connectivity offsets: (dr, dc, dist_mult, vec_x, vec_y)
        neighbors = [
            (-1, 0, 1.0, 0.0, 1.0),    # North
            (1, 0, 1.0, 0.0, -1.0),    # South
            (0, -1, 1.0, -1.0, 0.0),   # West
            (0, 1, 1.0, 1.0, 0.0),     # East
            (-1, -1, 1.414, -0.707, 0.707),  # NW
            (-1, 1, 1.414, 0.707, 0.707),    # NE
            (1, -1, 1.414, -0.707, -0.707),  # SW
            (1, 1, 1.414, 0.707, -0.707),    # SE
        ]

        # Wavefront propagation loop
        while pq:
            t_cur, r, c = heapq.heappop(pq)
            if t_cur > arrival_time_h[r, c]:
                continue
            z_cur = elevation[r, c]

            for dr, dc, dist_mult, vec_x, vec_y in neighbors:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < rows and 0 <= nc < cols):
                    continue

                step_dist_m = resolution_m * dist_mult
                dz = elevation[nr, nc] - z_cur

                # Directional slope acceleration (Rothermel 1972)
                # Uphill spread accelerates; downhill spread slows down
                slope_rad = math.atan(dz / step_dist_m)
                if dz > 0:
                    phi_s = 5.275 * (math.tan(slope_rad) ** 2)
                else:
                    phi_s = -0.35 * math.tan(abs(slope_rad))

                # Wind directional alignment: angle between step vector and wind vector
                spread_angle = math.atan2(vec_y, vec_x)
                theta_wind = spread_angle - wind_math_rad

                # Catchpole/Rothermel elliptical directional rate of spread multiplier:
                # Forward head fire (theta = 0): m_wind = 1.0
                # Backing fire (theta = pi): m_wind = (1-e)/(1+e) << 1.0
                # Flank fire (theta = +/- pi/2): m_wind ~ 1/lb
                m_wind = (1.0 - eccentricity) / max(0.001, (1.0 - eccentricity * math.cos(theta_wind)))
                directional_atten = 1.0 - eccentricity * 0.5 * (1.0 - math.cos(theta_wind))

                r0_local = cell_r0[nr, nc]
                aspect_factor = aspect_solar_grid[nr, nc]
                spread_factor = max(
                    0.03,
                    (1.0 + phi_w * m_wind) * max(0.2, 1.0 + phi_s) * directional_atten
                )
                ros_mh = r0_local * spread_factor * eta_m_base * aspect_factor
                ros_mh = max(1.5, ros_mh)  # Natural smolder creep limit (lowered from 3.5 for realism)

                travel_time_h = step_dist_m / ros_mh
                new_arrival = t_cur + travel_time_h

                if new_arrival < arrival_time_h[nr, nc]:
                    arrival_time_h[nr, nc] = new_arrival
                    heapq.heappush(pq, (new_arrival, nr, nc))
                    wind_drive_sum += abs(phi_w * m_wind)
                    slope_drive_sum += abs(phi_s)
                    drive_steps += 1

        # 7. Byram Flame Length & Fireline Intensity Estimation
        max_ros_mh = float(np.percentile(cell_r0 * (1.0 + phi_w) * eta_m_base, 95))
        fire_intensity_kw = 0.5 * max_ros_mh * (1.0 + wind_u_ms * 0.25)
        flame_length_m = round(0.0775 * (fire_intensity_kw ** 0.46) * f_spec["flame_mult"], 1)

        if max_ros_mh > 600 or flame_length_m > 4.5:
            fire_danger = "Catastrophic / Extreme"
        elif max_ros_mh > 350 or flame_length_m > 2.5:
            fire_danger = "Very High"
        elif max_ros_mh > 180:
            fire_danger = "High"
        else:
            fire_danger = "Moderate"

        # 8. Time-Step Frame Generation (Meter-by-Meter Advancement with Active Front vs Burn Scar)
        # Scale num_frames with duration for smooth animation: ~2 frames/hr, capped at 60.
        frames_from_duration = max(20, min(60, int(duration_hours * 2.5)))
        num_frames = int(scenario.get("num_frames", frames_from_duration))
        timesteps = np.linspace(0.0, duration_hours, num_frames).tolist()
        frames = []
        max_severity = np.zeros((rows, cols), dtype=np.float64)

        # Active flaming residence time: how long active flame burns before decaying to smolder
        flame_residence_h = max(0.35, min(1.2, 0.45 + 15.0 / max(30.0, max_ros_mh)))

        for t_idx, t in enumerate(timesteps):
            severity = np.zeros((rows, cols), dtype=np.float64)
            if t_idx == 0 or t <= 0.0:
                # Frame 0: ONLY the initial fire core seeded at ignition location
                severity[init_mask] = 1.0
                if not np.any(init_mask):
                    severity[ign_r, ign_c] = 1.0
            else:
                burned_mask = arrival_time_h <= t
                dt_burned = t - arrival_time_h

                # 1. Active advancing flaming front (leading fireline perimeter)
                active_flame_mask = burned_mask & (dt_burned <= flame_residence_h)

                # 2. Hot smoldering ember zone directly behind active flame
                smolder_mask = burned_mask & (dt_burned > flame_residence_h) & (dt_burned <= flame_residence_h * 2.2)

                # 3. Cold charred burn scar / ash bed
                scar_mask = burned_mask & (dt_burned > flame_residence_h * 2.2)

                severity[scar_mask] = 0.25         # Charred soot / ash scar (translucent soot)
                severity[smolder_mask] = 0.58       # Smoldering ember transition
                severity[active_flame_mask] = 1.0   # Active incandescent flame perimeter

            frames.append(np.round(severity, 2).tolist())
            max_severity = np.maximum(max_severity, severity)

        burn_area_km2 = round(float(np.sum(max_severity > 0.2) * (resolution_m**2) / 1e6), 2)

        # Dominant spread driver: wind (blowing towards heading) vs terrain slope
        if drive_steps > 0:
            mean_wind_drive = wind_drive_sum / drive_steps
            mean_slope_drive = slope_drive_sum / drive_steps
        else:
            mean_wind_drive = 0.0
            mean_slope_drive = 0.0
        if mean_wind_drive > 1.5 * max(mean_slope_drive, 1e-6):
            dominant_spread_driver = "wind"
        elif mean_slope_drive > 1.5 * max(mean_wind_drive, 1e-6):
            dominant_spread_driver = "slope"
        else:
            dominant_spread_driver = "mixed"

        timestep_labels = []
        for t in timesteps:
            total_m = int(round(t * 60))
            if total_m < 60:
                timestep_labels.append(f"{total_m}m")
            else:
                h = total_m // 60
                m = total_m % 60
                if m == 0:
                    timestep_labels.append(f"{h}h")
                else:
                    timestep_labels.append(f"{h}h {m}m")

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
            time_unit="hours",
            total_time=duration_hours,
            timestep_labels=timestep_labels,
            metadata={
                "wind_speed_kmh": wind_speed_kmh,
                "wind_direction_deg": wind_dir_deg,
                "temperature_c": temp_c,
                "humidity_pct": rh_pct,
                "fuel_type": fuel_type,
                "fuel_type_name": f_spec["name"],
                "fuel_auto_detected": fuel_auto_detected,
                "fuel_moisture_pct": fuel_moisture_pct,
                "effective_moisture_pct": round(effective_moist, 1),
                "recent_rainfall_mm": recent_rainfall_mm,
                "slope_deg": mean_slope_deg,
                "max_slope_deg": max_slope_deg,
                "ignition_slope_deg": ignition_slope_deg,
                "aspect_direction": dominant_aspect,
                "aspect_deg": mean_aspect_deg,
                "topography_mode": "Auto-Calculated from DEM 2D Gradients",
                "initial_fire_radius_m": initial_radius_m,
                "ignition_lat": round(ign_lat, 5),
                "ignition_lon": round(ign_lon, 5),
                "ignition_u": round(ign_u, 4),
                "ignition_v": round(ign_v, 4),
                "rate_of_spread_max_mh": round(max_ros_mh, 1),
                "flame_length_m": flame_length_m,
                "fire_danger_rating": fire_danger,
                "burn_area_km2": burn_area_km2,
                "dominant_spread_driver": dominant_spread_driver,
                "mean_wind_drive": round(mean_wind_drive, 3),
                "mean_slope_drive": round(mean_slope_drive, 3),
            },
        )
