"""DisasterLens Backend Configuration"""
import os

# Try loading from .env if present
_env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env_path):
    try:
        with open(_env_path, "r", encoding="utf-8") as _f:
            for _line in _f:
                _line = _line.strip()
                if _line and not _line.startswith("#") and "=" in _line:
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
    except Exception:
        pass

# Gemini API Key — set via environment variable
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

# Open-Meteo Elevation API
ELEVATION_API_URL = "https://api.open-meteo.com/v1/elevation"

# Overpass API
OVERPASS_API_URL = "https://overpass-api.de/api/interpreter"
# Failover mirrors tried (in order) when the primary Overpass instance fails
OVERPASS_MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
]

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

# --- Shared cache + AI context limits (append-only; do not rename above) ---
CACHE_TTL_SECONDS = 1800  # 30-minute spatial cache time-to-live
CACHE_MAX_ENTRIES = 32  # max cached payloads held per cache tier
MAX_SCENARIO_CHARS = 6000  # max scenario JSON chars interpolated into AI prompts
GEMINI_TIMEOUT_MS = 30000  # google-genai HTTP timeout in milliseconds

# --- Cyclone wind-speed thresholds (mirror simulation/cyclone.py literals) ---
CYCLONE_WIND_MIN_KMH = 50.0  # minimum supported max sustained wind
CYCLONE_WIND_MAX_KMH = 320.0  # maximum supported max sustained wind
HURRICANE_FORCE_WIND_KMH = 118.0  # impact threshold (Cat 1 begins at 119 km/h)
CYCLONE_CAT1_KMH = 119.0
CYCLONE_CAT2_KMH = 154.0
CYCLONE_CAT3_KMH = 178.0
CYCLONE_CAT4_KMH = 209.0
CYCLONE_CAT5_KMH = 252.0
CYCLONE_PRESSURE_MIN_HPA = 870.0
CYCLONE_PRESSURE_MAX_HPA = 1010.0

# --- Storm-surge thresholds (alias of flood depth thresholds) ---
SURGE_DEPTH_MIN = FLOOD_DEPTH_MIN
SURGE_ROAD_OPEN_THRESHOLD = ROAD_OPEN_THRESHOLD
SURGE_ROAD_RESTRICTED_THRESHOLD = ROAD_RESTRICTED_THRESHOLD
SURGE_BUILDING_FLOOD_THRESHOLD = BUILDING_FLOOD_THRESHOLD
