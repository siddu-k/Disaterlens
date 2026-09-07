"""Fetch raw Mumbai geodata from the Overpass API (one-off data acquisition)."""
import argparse
import json
import logging
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_BBOX = "18.9800,72.8150,19.0350,72.8650"
DEFAULT_OUTPUT = BASE_DIR / "real_osm_mumbai.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def main(bbox: str = DEFAULT_BBOX, output_path: Path = DEFAULT_OUTPUT, timeout: int = 45) -> None:
    query = f"""
[out:json][timeout:30];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"]({bbox});
  nwr["amenity"="hospital"]({bbox});
  nwr["amenity"="shelter"]({bbox});
  nwr["emergency"="assembly_point"]({bbox});
  nwr["amenity"="school"]({bbox});
);
out geom 300;
"""

    logger.info("[Script] Querying Overpass API for real Mumbai geodata...")
    headers = {
        "User-Agent": "DisasterLens/2.0 (contact@disasterlens.org; emergency response simulation)"
    }
    try:
        r = requests.post(OVERPASS_URL, data={"data": query}, headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        elements = data.get("elements", [])
        logger.info(f"[Script] Successfully fetched {len(elements)} real elements from OSM!")

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(elements, f, indent=2)
        logger.info(f"[Script] Saved raw real OSM data to {output_path}")
    except Exception as e:
        logger.warning(f"[Script] Overpass error: {e}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Fetch raw Mumbai geodata from the Overpass API.")
    parser.add_argument("--bbox", default=DEFAULT_BBOX, help="Bounding box as south,west,north,east")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Path for raw OSM JSON output")
    parser.add_argument("--timeout", type=int, default=45, help="HTTP timeout in seconds")
    args = parser.parse_args()
    main(bbox=args.bbox, output_path=args.output, timeout=args.timeout)
