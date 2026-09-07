"""
DisasterLens — Landslide Infinite Slope Stability Engine (SHALSTAB)
===================================================================
Physically-based geotechnical slope stability model computing Factor of Safety
(FS) and Landslide Susceptibility Index (LSI) driven by terrain slope (DEM),
soil cohesion, internal friction angle, and rainfall pore-water pressure.
"""

import numpy as np
import math
from typing import Dict, Any, List, Tuple, Optional
from simulation.base import BaseHazardModule, HazardOutput


class LandslideHazardModule(BaseHazardModule):
    disaster_type = "landslide"
    model_name = "Infinite Slope Stability & SHALSTAB Pore-Pressure Solver"
    version = "v1.5-shalstab"
    units = {"factor_of_safety": "Dimensionless ratio (<1.0 is failure)", "susceptibility_index": "Index (0-1.0)"}
    assumptions = [
        "Planar slip surface parallel to local topographic slope at shallow regolith depth (z=1.5m)",
        "Subsurface hydrology: rainfall accumulation drives steady-state pore-water pressure ratio m",
        "Geotechnical properties representative of tropical/subtropical weathered residual soil",
        "Debris flow runout paths follow steepest descent flow accumulation",
    ]
    uncertainty_description = (
        "Uncertainty arises from localized rock joints, anthropogenic slope cutting, "
        "and unknown spatial heterogeneity in regolith mantle thickness."
    )
    governing_equations = (
        "FS = (c' + (gamma - m*gamma_w)*z*cos(theta)^2*tan(phi)) / (gamma*z*sin(theta)*cos(theta))"
    )
    scientific_references = [
        "Montgomery, D.R. & Dietrich, W.E. (1994). A physically based model for the topographic control on shallow landsliding. WRR 30(4):1153-1171.",
        "Pack, R.T., Tarboton, D.G., & Goodwin, C.N. (1998). The SINMAP approach to terrain stability mapping. 8th Congress IAEG, Vancouver.",
    ]

    def validate_parameters(self, scenario: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        rainfall = scenario.get("cumulative_rainfall_mm", scenario.get("rainfall_mm", 200.0))
        duration = scenario.get("duration_hours", 24.0)
        if not (0 <= rainfall <= 2000):
            return False, f"Cumulative rainfall {rainfall}mm outside range (0 - 2000mm)"
        if not (1 <= duration <= 168):
            return False, f"Duration {duration}h outside range (1 - 168h)"
        return True, None

    def run_simulation(
        self,
        elevation: np.ndarray,
        geodata: Dict[str, Any],
        scenario: Dict[str, Any],
        resolution_m: float = 90.0,
        bbox: Optional[Dict[str, float]] = None,
    ) -> HazardOutput:
        rainfall_mm = float(scenario.get("cumulative_rainfall_mm", scenario.get("rainfall_mm", 220.0)))
        duration_hours = float(scenario.get("duration_hours", 24.0))

        rows, cols = elevation.shape

        # Geotechnical soil parameters (typical weathered sandy loam / silty clay)
        c_prime = 6.0  # Effective cohesion in kPa (kN/m²)
        phi_deg = 33.0  # Internal friction angle (degrees)
        phi_rad = np.radians(phi_deg)
        gamma = 18.0  # Total soil unit weight (kN/m³)
        gamma_w = 9.81  # Water unit weight (kN/m³)
        z = 1.6  # Soil mantle failure depth in meters

        # Calculate slope angle theta from DEM
        dy, dx = np.gradient(elevation, resolution_m, resolution_m)
        slope_rad = np.arctan(np.sqrt(dx**2 + dy**2))
        slope_deg = np.degrees(slope_rad)
        # Avoid singular divide-by-zero on flat land
        theta = np.clip(slope_rad, np.radians(1.5), np.radians(65.0))

        # Identify initial slope detachment source zones (SHALSTAB failure where FS <= 1.05 and slope >= 12°)
        m_ratio = np.clip((rainfall_mm / 180.0) ** 1.1, 0.25, 0.96)
        numerator = c_prime + (gamma - m_ratio * gamma_w) * z * (np.cos(theta)**2) * np.tan(phi_rad)
        denominator = gamma * z * np.sin(theta) * np.cos(theta)
        fs = numerator / np.maximum(denominator, 0.01)

        source_scar = np.where(
            (fs <= 1.10) & (slope_deg >= 10.0),
            np.clip((1.15 - fs) / 0.40, 0.35, 1.0),
            0.0
        )
        # If terrain has few extreme slopes, trigger on highest 10% slope cells if heavy rain
        if np.max(source_scar) < 0.3 and rainfall_mm > 100.0:
            high_slope_thresh = np.percentile(slope_deg, 90)
            source_scar = np.where(
                slope_deg >= max(8.0, high_slope_thresh),
                np.clip((slope_deg - high_slope_thresh) / 10.0 + 0.4, 0.3, 0.85),
                0.0
            )

        # Dynamic Debris Flow Runout Solver (Kinematic Wave downslope transport)
        # In nature, landslides occur rapidly: failure -> debris avalanche -> deposition in 10-15 MINUTES
        timesteps = [0.0, 2.0, 5.0, 8.0, 12.0, 15.0]  # minutes
        timestep_labels = ["0 min", "2 min", "5 min", "8 min", "12 min", "15 min"]
        frames = []

        # Find steepest downhill descent directions for all cells
        dr = [-1, -1, -1,  0, 0,  1,  1,  1]
        dc = [-1,  0,  1, -1, 1, -1,  0,  1]
        dist_w = [1.414, 1.0, 1.414, 1.0, 1.0, 1.414, 1.0, 1.414]

        # Downhill receiver map: receiver_r, receiver_c
        receiver_r = np.arange(rows)[:, None].repeat(cols, axis=1)
        receiver_c = np.arange(cols)[None, :].repeat(rows, axis=0)
        max_down_slope = np.zeros((rows, cols), dtype=np.float64)

        for k in range(8):
            nr = np.clip(receiver_r + dr[k], 0, rows - 1)
            nc = np.clip(receiver_c + dc[k], 0, cols - 1)
            drop = (elevation - elevation[nr, nc]) / (dist_w[k] * resolution_m)
            steeper = drop > max_down_slope
            max_down_slope[steeper] = drop[steeper]
            receiver_r[steeper] = nr[steeper]
            receiver_c[steeper] = nc[steeper]

        # Simulate progressive downslope debris propagation across the 15-minute event
        current_debris = np.zeros((rows, cols), dtype=np.float64)
        max_hazard_lsi = np.zeros((rows, cols), dtype=np.float64)

        for t_idx, t_min in enumerate(timesteps):
            if t_idx == 0 or t_min <= 0.0:
                frames.append(np.zeros((rows, cols), dtype=np.float64).tolist())
                continue

            # Stage 1: Crown rupture and detachment (t = 2 min)
            if t_idx == 1:
                current_debris = source_scar.copy()
            else:
                # Stage 2-5: Debris flow avalanche cascades downslope along steepest gradient
                next_debris = current_debris.copy()
                # Transport debris to downstream receiver cells
                for r in range(rows):
                    for c in range(cols):
                        val = current_debris[r, c]
                        if val > 0.08 and max_down_slope[r, c] > 0.01:
                            rr = receiver_r[r, c]
                            cc = receiver_c[r, c]
                            # Frictional damping coefficient
                            down_val = val * 0.88
                            if down_val > next_debris[rr, cc]:
                                next_debris[rr, cc] = down_val
                current_debris = np.maximum(next_debris, source_scar * 0.75)

            current_frame_lsi = np.clip(current_debris, 0.0, 1.0)
            frames.append(np.round(current_frame_lsi, 2).tolist())
            max_hazard_lsi = np.maximum(max_hazard_lsi, current_frame_lsi)

        critical_cells = np.sum(max_hazard_lsi >= 0.6)
        unstable_area_km2 = float(critical_cells * (resolution_m**2) / 1e6)

        return HazardOutput(
            disaster_type="landslide",
            model_name="SHALSTAB & Kinematic Debris Flow Runout Solver",
            timesteps=timesteps,
            frames=frames,
            max_hazard=np.round(max_hazard_lsi, 2).tolist(),
            rows=rows,
            cols=cols,
            hazard_unit="Landslide Susceptibility Index (0-1.0)",
            threshold_impact=0.60,
            total_time_hours=round(15.0 / 60.0, 3),  # 0.25h for legacy compatibility
            time_unit="minutes",
            total_time=15.0,
            timestep_labels=timestep_labels,
            metadata={
                "antecedent_rainfall_mm": rainfall_mm,
                "duration_hours": duration_hours,
                "event_duration_min": 15.0,
                "unstable_area_km2": round(unstable_area_km2, 2),
                "peak_susceptibility": round(float(np.max(max_hazard_lsi)), 2),
                "model": "SHALSTAB Failure Initiation + Dynamic Valley Runout",
            },
        )
