"""DisasterLens Backend Configuration"""
import os

# Gemini API Key — set via environment variable
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Open-Meteo Elevation API
ELEVATION_API_URL = "https://api.open-meteo.com/v1/elevation"

# Overpass API
OVERPASS_API_URL = "https://overpass-api.de/api/interpreter"

# Simulation defaults
DEFAULT_MANNING_N = 0.035  # Manning's roughness for urban areas
DEFAULT_GRID_RESOLUTION = 90  # meters (matches Copernicus DEM)
DEFAULT_TIME_STEP = 60  # seconds
SIMULATION_OUTPUT_INTERVAL = 1800  # seconds (output every 30 min)

# Impact thresholds (meters of water depth)
ROAD_OPEN_THRESHOLD = 0.15
ROAD_RESTRICTED_THRESHOLD = 0.45
BUILDING_FLOOD_THRESHOLD = 0.08
FLOOD_DEPTH_MIN = 0.02  # minimum depth (2cm) to count as active street sheet flow / ponding

# Population estimation
PEOPLE_PER_BUILDING = 25  # average for urban areas
