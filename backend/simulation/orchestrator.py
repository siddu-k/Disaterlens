"""
DisasterLens — Modular Disaster Orchestrator
=============================================
Central registry and dispatcher for all multi-hazard simulation engines.
Every disaster operates as an independent plugin adhering to BaseHazardModule.
"""

from typing import Dict, Any, List, Tuple, Optional
import numpy as np
from simulation.base import BaseHazardModule, HazardOutput
from simulation.flood import FloodHazardModule
from simulation.earthquake import EarthquakeHazardModule
from simulation.wildfire import WildfireHazardModule
from simulation.landslide import LandslideHazardModule
from simulation.cyclone import CycloneHazardModule

MODULE_CLASSES = {
    "flood": FloodHazardModule,
    "earthquake": EarthquakeHazardModule,
    "wildfire": WildfireHazardModule,
    "landslide": LandslideHazardModule,
    "cyclone": CycloneHazardModule,
}

MODULE_REGISTRY: Dict[str, BaseHazardModule] = {
    key: cls() for key, cls in MODULE_CLASSES.items()
}


def get_available_disasters() -> List[Dict[str, Any]]:
    """List all registered disaster modules with their scientific specifications."""
    disasters = []
    for key, cls in MODULE_CLASSES.items():
        mod = cls()
        meta = mod.get_metadata(resolution_m=90.0, timestep_hours=4.0)
        disasters.append({
            "type": key,
            "name": key.title(),
            "model_name": meta.model_name,
            "version": meta.version,
            "units": meta.units,
            "assumptions": meta.assumptions,
            "uncertainty": meta.uncertainty_description,
        })
    return disasters


def run_hazard_simulation(
    disaster_type: str,
    elevation: np.ndarray,
    geodata: Dict[str, Any],
    scenario: Dict[str, Any],
    resolution_m: float = 90.0,
    bbox: Optional[Dict[str, float]] = None,
) -> HazardOutput:
    """Validate scenario and execute the appropriate disaster module."""
    disaster_key = disaster_type.lower()
    if disaster_key not in MODULE_CLASSES:
        raise ValueError(f"Unsupported disaster type '{disaster_type}'. Registered: {list(MODULE_CLASSES.keys())}")

    module = MODULE_CLASSES[disaster_key]()
    valid, err = module.validate_parameters(scenario)
    if not valid:
        raise ValueError(f"Invalid parameters for {disaster_type}: {err}")

    return module.run_simulation(
        elevation=elevation,
        geodata=geodata,
        scenario=scenario,
        resolution_m=resolution_m,
        bbox=bbox,
    )
