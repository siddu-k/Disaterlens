"""
DisasterLens — Base Hazard Module Interface
============================================
Every disaster module implements this interface, ensuring strict typing,
transparent scientific assumptions, uncertainty bounds, and consistent
geospatial outputs for the GIS Impact Engine.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Tuple, Optional
import numpy as np
from pydantic import BaseModel, Field


class HazardMetadata(BaseModel):
    disaster_type: str
    model_name: str
    version: str
    units: Dict[str, str]
    resolution_m: float
    timestep_hours: float
    assumptions: List[str]
    uncertainty_description: str
    governing_equations: str
    scientific_references: List[str]


class HazardOutput(BaseModel):
    disaster_type: str
    model_name: str
    timesteps: List[float] = Field(description="Timestep points in native time_unit")
    frames: List[List[List[float]]] = Field(description="2D grids for each timestep")
    max_hazard: List[List[float]] = Field(description="Envelope of maximum intensity/depth across all timesteps")
    rows: int
    cols: int
    hazard_unit: str
    threshold_impact: float = Field(description="Threshold at which exposure suffers moderate-to-severe impact")
    total_time_hours: float
    time_unit: str = Field(default="hours", description="Time unit of timesteps: seconds, minutes, or hours")
    total_time: float = Field(default=24.0, description="Total duration in time_unit")
    timestep_labels: List[str] = Field(default_factory=list, description="Human-readable labels for each timestep")
    metadata: Dict[str, Any]


class BaseHazardModule(ABC):
    """Abstract Base Class for all DisasterLens hazard plugins."""

    disaster_type: str
    model_name: str
    version: str
    units: Dict[str, str]
    assumptions: List[str]
    uncertainty_description: str
    governing_equations: str
    scientific_references: List[str]

    @abstractmethod
    def validate_parameters(self, scenario: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """Validate input scenario parameters against the disaster schema."""
        pass

    @abstractmethod
    def run_simulation(
        self,
        elevation: np.ndarray,
        geodata: Dict[str, Any],
        scenario: Dict[str, Any],
        resolution_m: float = 90.0,
        bbox: Optional[Dict[str, float]] = None,
    ) -> HazardOutput:
        """Execute the physical or empirical hazard model and return normalized grids."""
        pass

    def get_metadata(self, resolution_m: float, timestep_hours: float) -> HazardMetadata:
        """Return standardized metadata object."""
        return HazardMetadata(
            disaster_type=self.disaster_type,
            model_name=self.model_name,
            version=self.version,
            units=self.units,
            resolution_m=resolution_m,
            timestep_hours=timestep_hours,
            assumptions=self.assumptions,
            uncertainty_description=self.uncertainty_description,
            governing_equations=self.governing_equations,
            scientific_references=self.scientific_references,
        )
