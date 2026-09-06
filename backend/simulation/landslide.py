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

        # Simulation across timesteps as rainfall progressively saturates the soil profile
        num_frames = 6
        timesteps = np.linspace(0.0, duration_hours, num_frames).tolist()
        frames = []

        max_hazard_lsi = np.zeros((rows, cols), dtype=np.float64)

        for t in timesteps:
            # Saturation fraction m(t): increases with cumulative rainfall
            # Saturated hydraulic conductivity ~ 25 mm/h
            rain_so_far = (t / max(duration_hours, 1.0)) * rainfall_mm
            m_ratio = np.clip((rain_so_far / 180.0) ** 1.2, 0.05, 0.98)

            # Infinite slope stability equation:
            # Resisting shear stress:
            numerator = c_prime + (gamma - m_ratio * gamma_w) * z * (np.cos(theta)**2) * np.tan(phi_rad)
            # Driving shear stress:
            denominator = gamma * z * np.sin(theta) * np.cos(theta)
            fs = numerator / np.maximum(denominator, 0.01)

            # Map Factor of Safety to Landslide Susceptibility Index (0.0 to 1.0)
            # FS > 1.5 -> LSI < 0.2 (Stable)
            # FS < 1.0 -> LSI = 1.0 (Failure)
            lsi = np.where(
                fs >= 1.6,
                0.1,
                np.where(
                    fs >= 1.2,
                    0.35 + 0.25 * (1.6 - fs) / 0.4,
                    np.where(
                        fs >= 1.0,
                        0.65 + 0.25 * (1.2 - fs) / 0.2,
                        1.0  # Failure / critical
                    )
                )
            )
            # On flat ground (slope < 5°), landslides cannot occur
            flat_mask = slope_deg < 5.0
            lsi[flat_mask] = 0.0

            frames.append(np.round(lsi, 2).tolist())
            max_hazard_lsi = np.maximum(max_hazard_lsi, lsi)

        critical_cells = np.sum(max_hazard_lsi >= 0.7)
        unstable_area_km2 = float(critical_cells * (resolution_m**2) / 1e6)

        return HazardOutput(
            disaster_type="landslide",
            model_name=self.model_name,
            timesteps=[round(t, 2) for t in timesteps],
            frames=frames,
            max_hazard=np.round(max_hazard_lsi, 2).tolist(),
            rows=rows,
            cols=cols,
            hazard_unit="Landslide Susceptibility Index (0-1.0)",
            threshold_impact=0.65,  # High susceptibility threshold
            total_time_hours=duration_hours,
            metadata={
                "rainfall_mm": rainfall_mm,
                "duration_hours": duration_hours,
                "unstable_area_km2": round(unstable_area_km2, 2),
                "peak_susceptibility": round(float(np.max(max_hazard_lsi)), 2),
            },
        )
