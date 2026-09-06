import requests
import json
import os

bbox = "18.9800,72.8150,19.0350,72.8650"
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

print("[Script] Querying Overpass API for real Mumbai geodata...")
headers = {
    "User-Agent": "DisasterLens/2.0 (contact@disasterlens.org; emergency response simulation)"
}
try:
    r = requests.post("https://overpass-api.de/api/interpreter", data={"data": query}, headers=headers, timeout=45)
    r.raise_for_status()
    data = r.json()
    elements = data.get("elements", [])
    print(f"[Script] Successfully fetched {len(elements)} real elements from OSM!")
    
    out_path = os.path.join(os.path.dirname(__file__), "real_osm_mumbai.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(elements, f, indent=2)
    print(f"[Script] Saved raw real OSM data to {out_path}")
except Exception as e:
    print(f"[Script] Overpass error: {e}")
