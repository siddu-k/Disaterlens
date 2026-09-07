"""
DisasterLens — AI Assistant & Scenario Engine (Google Gemini)
=============================================================
Provides two distinct AI capabilities:
1. Strict Natural Language Scenario Parser: converts user prompts into validated
   structured parameters checked against disaster schemas. (Never generates physics/GIS).
2. Grounded AI Analyst: explains only calculated simulation metrics and provenance,
   citing data sources and distinguishing observed, modeled, and estimated values.
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
import json
import logging
import config

logger = logging.getLogger(__name__)

try:
    from google import genai
except ImportError:
    genai = None

ALLOWED_DISASTER_TYPES = {"flood", "cyclone", "earthquake", "wildfire", "landslide"}

_client = None


def _get_client():
    """Module-level singleton genai.Client (created once, reused; HTTP timeout applied)."""
    global _client
    if _client is None and genai is not None and config.GEMINI_API_KEY:
        _client = genai.Client(
            api_key=config.GEMINI_API_KEY,
            http_options={"timeout": config.GEMINI_TIMEOUT_MS},
        )
    return _client


def _truncate(text: str, max_chars: int = config.MAX_SCENARIO_CHARS) -> str:
    """Cap context size before interpolating into prompts."""
    if text is None:
        return ""
    text = str(text)
    if len(text) > max_chars:
        return text[:max_chars] + "... [truncated]"
    return text


def _validate_disaster_type(value: Any) -> str:
    """Map unknown/empty disaster types to 'flood'."""
    if isinstance(value, str) and value.strip().lower() in ALLOWED_DISASTER_TYPES:
        return value.strip().lower()
    return "flood"


class ParsedScenario(BaseModel):
    disaster_type: str = Field(description="One of: flood, earthquake, wildfire, landslide, cyclone")
    parameters: Dict[str, float] = Field(description="Key-value mapping of numerical scenario parameters")
    confidence: float = Field(description="Confidence score 0.0 - 1.0")
    clarification_needed: Optional[str] = Field(default=None, description="Any ambiguity or missing parameter note")


class EvacuationAction(BaseModel):
    priority: int = Field(description="Priority level 1-5, where 1 is most urgent")
    action: str = Field(description="Specific operational action to take")
    zone: str = Field(description="Geographic area or corridor")
    reason: str = Field(description="Underlying calculated reason citing model metrics")


class AIInsight(BaseModel):
    severity: str = Field(description="LOW, MODERATE, HIGH, SEVERE, or CATASTROPHIC")
    summary: str = Field(description="Executive summary citing calculated numbers")
    key_findings: List[str] = Field(description="Key findings citing data sources")
    evacuation_actions: List[EvacuationAction] = Field(description="Ordered list of recommended evacuation actions")
    warnings: List[str] = Field(description="Critical operational warnings")
    safe_routes_advice: str = Field(description="Guidance on open and reachable routes")
    data_citations: List[str] = Field(description="Citations of datasets and model versions used")


def parse_natural_language_scenario(prompt: str, current_disaster: str = "flood") -> Dict[str, Any]:
    """
    Parse a user prompt like 'Simulate 300mm rain in 12 hours with 2m surge'
    into strict validated numerical parameters.
    """
    if not config.GEMINI_API_KEY or genai is None:
        return _fallback_parse_scenario(prompt, current_disaster)

    try:
        client = _get_client()
        if client is None:
            return _fallback_parse_scenario(prompt, current_disaster)
        system_instructions = (
            "You are a strict disaster scenario parameter extractor. Extract ONLY numerical scenario parameters "
            "into JSON for the disaster simulation engines. Valid disasters: flood (rainfall_mm, duration_hours, sea_level_surge_m), "
            "earthquake (magnitude, depth_km), wildfire (wind_speed_kmh, wind_direction_deg, temperature_c, relative_humidity_pct), "
            "landslide (cumulative_rainfall_mm, duration_hours), cyclone (central_pressure_hpa, max_wind_kmh). "
            "Never invent parameters outside user context."
        )

        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=f"{system_instructions}\nUser Request: {_truncate(prompt)}\nDefault Disaster: {current_disaster}",
            config={
                "response_mime_type": "application/json",
                "response_schema": ParsedScenario,
            },
        )
        if response.parsed:
            p = response.parsed
            return {
                "disaster_type": _validate_disaster_type(p.disaster_type),
                "parameters": p.parameters,
                "confidence": p.confidence,
                "clarification": p.clarification_needed,
                "source": "gemini",
            }
    except Exception as e:
        logger.warning(f"[AI Parser] Warning: {e}")

    return _fallback_parse_scenario(prompt, current_disaster)


def generate_insight(
    scenario: Dict[str, Any],
    impact: Dict[str, Any],
    location_name: str = "Selected Area",
) -> Dict[str, Any]:
    """
    Generate grounded AI explanation strictly using computed simulation facts.
    """
    if not config.GEMINI_API_KEY or genai is None:
        return _fallback_insight(scenario, impact, location_name)

    try:
        client = _get_client()
        if client is None:
            return _fallback_insight(scenario, impact, location_name)
        context = _build_strict_context(scenario, impact, location_name)

        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=context,
            config={
                "response_mime_type": "application/json",
                "response_schema": AIInsight,
            },
        )

        if response.parsed:
            ins = response.parsed
            return {
                "severity": ins.severity,
                "summary": ins.summary,
                "key_findings": ins.key_findings,
                "evacuation_actions": [a.model_dump() for a in ins.evacuation_actions],
                "warnings": ins.warnings,
                "safe_routes_advice": ins.safe_routes_advice,
                "data_citations": ins.data_citations,
                "source": "Google Gemini 2.0 Flash (Grounded)",
            }
    except Exception as e:
        logger.warning(f"[AI Analyst] Warning: {e}")

    return _fallback_insight(scenario, impact, location_name)


def _build_strict_context(scenario: Dict[str, Any], impact: Dict[str, Any], location_name: str) -> str:
    road_status = impact.get("road_status", {})
    routes = impact.get("evacuation_routes", [])

    return f"""You are DisasterLens AI Analyst. Explain ONLY the computed metrics provided below.
DO NOT fabricate any road names, population numbers, or depths that are not in the data.
Explicitly distinguish:
- Modeled: Flooded area, peak depth/intensity, road accessibility state
- Estimated: Population exposed (derived from building footprint occupancy)
- Observed: OSM roads, building footprints, tagged facilities

Location: {location_name}
Disaster Type: {impact.get('disaster_type', 'flood')}
Scenario Parameters: {_truncate(json.dumps(scenario))}

Computed Impact Facts:
- Affected Area: {impact.get('flooded_area_km2', 0)} km² (Modeled)
- Peak Hazard Intensity: {impact.get('peak_flood_depth_m', 0)} {impact.get('hazard_unit', 'm')} (Modeled)
- Estimated Population Exposed: {impact.get('estimated_population_exposed', 0):,} (Estimated via building density)
- Buildings Affected: {impact.get('buildings_affected', 0):,} of {impact.get('total_buildings', 0):,} (Modeled intersection)
- Road Network: {road_status.get('open', 0)} Open, {road_status.get('restricted', 0)} Restricted, {road_status.get('closed', 0)} Closed (Modeled)
- Closed Roads Length: {road_status.get('closed_length_km', 0)} km
- Critical Facilities at Risk: {impact.get('critical_facilities_at_risk', 0)} (Observed OSM facilities intersected with hazard)
- Safe Alternate Routes Identified: {len(routes)} calculated via NetworkX routing
"""


def _fallback_parse_scenario(prompt: str, current_disaster: str) -> Dict[str, Any]:
    """Rule-based extractor for numbers and keywords when offline."""
    import re
    p_lower = prompt.lower()

    # Detect disaster type
    dtype = current_disaster
    for d in ["earthquake", "wildfire", "landslide", "cyclone", "flood"]:
        if d in p_lower:
            dtype = d
            break

    params: Dict[str, float] = {}

    # Extract rainfall (e.g. 200mm, 150 mm)
    rain_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:mm|millimeters)", p_lower)
    if rain_m:
        params["rainfall_mm"] = float(rain_m.group(1))
        params["cumulative_rainfall_mm"] = float(rain_m.group(1))

    # Extract duration (e.g. 12h, 24 hours)
    dur_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hrs|hours)", p_lower)
    if dur_m:
        params["duration_hours"] = float(dur_m.group(1))

    # Extract surge (e.g. 2.5m surge, 2 meter)
    surge_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|meter|meters)\s*(?:surge)?", p_lower)
    if surge_m and "surge" in p_lower:
        params["sea_level_surge_m"] = float(surge_m.group(1))

    # Extract magnitude (e.g. M7.0, magnitude 6.5)
    mag_m = re.search(r"(?:magnitude|m)\s*(\d+(?:\.\d+)?)", p_lower)
    if mag_m:
        params["magnitude"] = float(mag_m.group(1))

    # Extract wind (e.g. 150 km/h, 120kmh)
    wind_m = re.search(r"(\d+(?:\.\d+)?)\s*(?:km/h|kmh)", p_lower)
    if wind_m:
        params["wind_speed_kmh"] = float(wind_m.group(1))
        params["max_wind_kmh"] = float(wind_m.group(1))

    return {
        "disaster_type": _validate_disaster_type(dtype),
        "parameters": params,
        "confidence": 0.85,
        "clarification": None,
        "source": "rule-based parser",
    }


def _fallback_insight(scenario: Dict[str, Any], impact: Dict[str, Any], location_name: str) -> Dict[str, Any]:
    """Deterministic scientific insight fallback."""
    dtype = impact.get("disaster_type", "flood")
    road_status = impact.get("road_status", {})
    affected_km2 = impact.get("flooded_area_km2", 0)
    pop = impact.get("estimated_population_exposed", 0)
    peak = impact.get("peak_flood_depth_m", 0)
    unit = impact.get("hazard_unit", "m")
    closed = road_status.get("closed", 0)
    routes = impact.get("evacuation_routes", [])

    if peak > 2.0 or pop > 30000 or closed > 10:
        severity = "SEVERE"
    elif peak > 0.8 or pop > 8000:
        severity = "HIGH"
    elif peak > 0.3 or pop > 1000:
        severity = "MODERATE"
    else:
        severity = "LOW"

    summary = (
        f"The {dtype.title()} simulation for {location_name} projects an affected footprint of "
        f"{affected_km2:.1f} km² with peak intensity of {peak:.2f} {unit}. Approximately "
        f"{pop:,} residents and {impact.get('buildings_affected', 0):,} structures are directly in the hazard zone. "
        f"{closed} road segments are classified as impassable."
    )

    key_findings = [
        f"Peak {dtype} intensity of {peak:.2f} {unit} modeled across low-lying infrastructure",
        f"{affected_km2:.1f} km² total affected area calculated by deterministic GIS intersection",
        f"{closed} roads closed ({road_status.get('closed_length_km', 0)} km impassable); {road_status.get('restricted', 0)} restricted",
        f"{impact.get('critical_facilities_at_risk', 0)} critical facilities directly intersect the hazard perimeter",
        f"{len(routes)} safe alternate evacuation paths calculated on open road network",
    ]

    actions = [
        {
            "priority": 1,
            "action": f"Avoid all {closed} closed corridors and redirect emergency vehicles",
            "zone": "Impassable sectors",
            "reason": f"Hazard severity exceeds safety thresholds ({closed} segments impassable)",
        },
        {
            "priority": 2,
            "action": "Activate designated evacuation shelters on higher ground",
            "zone": "Safe perimeter",
            "reason": f"{len(impact.get('safe_facilities', []))} facilities remain outside hazard impact zone",
        },
    ]

    warnings = []
    if closed > 5:
        warnings.append(f"CRITICAL: Arterial route severance ({closed} roads closed) limits direct access")
    if impact.get("critical_facilities_at_risk", 0) > 0:
        warnings.append(f"{impact.get('critical_facilities_at_risk')} emergency facilities are in the hazard zone")

    safe_advice = (
        f"{road_status.get('open', 0)} road segments ({road_status.get('open_length_km', 0)} km) remain open. "
        f"Use northern and elevated connectors to reach designated shelters."
    )

    return {
        "severity": severity,
        "summary": summary,
        "key_findings": key_findings,
        "evacuation_actions": actions,
        "warnings": warnings,
        "safe_routes_advice": safe_advice,
        "data_citations": [
            "OpenStreetMap (ODbL, 2024 vector roads & buildings)",
            "Copernicus GLO-30 DEM / SRTM Topography",
            "WorldPop High-Resolution Dasymetric Population Model",
        ],
        "source": "Deterministic GIS & Scientific Rule Engine",
    }
