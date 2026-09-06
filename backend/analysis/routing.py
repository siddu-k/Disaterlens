"""
DisasterLens — Road Network Graph & Evacuation Routing Engine
=============================================================
Constructs a topological road network graph from OSM road geometries
using NetworkX. Evaluates real road accessibility under hazard closures
and computes safe evacuation routes to reachable shelters and hospitals.
"""

import math
from typing import Dict, Any, List, Tuple, Optional
import networkx as nx


def build_road_network_graph(roads: List[Dict[str, Any]]) -> nx.Graph:
    """
    Build NetworkX spatial graph from OSM road geometries.
    Nodes are rounded lat/lon intersection coordinates.
    Edges contain length (m), travel time (s), and status (open/restricted/closed).
    """
    G = nx.Graph()

    for road in roads:
        coords = road.get("coords", [])
        if len(coords) < 2:
            continue

        status = road.get("status", "open")
        length_m = road.get("length_m", 100.0)
        road_id = road.get("id")
        name = road.get("name", "Road")
        hway_type = road.get("type", "residential")

        # Typical speeds (km/h) -> m/s
        speed_kmh = 60 if hway_type in ["motorway", "trunk"] else 40 if hway_type in ["primary", "secondary"] else 25
        if status == "restricted":
            speed_kmh = max(10, speed_kmh * 0.35)  # severe delay through restricted/submerged segment
        speed_ms = speed_kmh / 3.6

        # Chain segments along road vertices
        for i in range(len(coords) - 1):
            p1 = (round(coords[i][1], 5), round(coords[i][0], 5))  # (lat, lon)
            p2 = (round(coords[i+1][1], 5), round(coords[i+1][0], 5))

            seg_len = _haversine(p1[0], p1[1], p2[0], p2[1])
            time_s = seg_len / speed_ms

            # Impedance weight: closed roads have prohibitive cost
            if status == "closed":
                weight = 1e9
            elif status == "restricted":
                weight = time_s * 3.5
            else:
                weight = time_s

            G.add_edge(
                p1, p2,
                weight=weight,
                length_m=seg_len,
                time_s=time_s,
                status=status,
                road_name=name,
                road_id=road_id,
            )

    return G


def compute_evacuation_routes(
    roads: List[Dict[str, Any]],
    facilities: List[Dict[str, Any]],
    start_points: Optional[List[Dict[str, float]]] = None,
    bbox: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    """
    Compute optimal safe evacuation paths from affected areas to reachable shelters.
    Avoids closed roads and accounts for restricted road delays.
    """
    G = build_road_network_graph(roads)
    if len(G.nodes) == 0:
        return []

    # Safe shelters / hospitals (not flooded / undamaged)
    safe_targets = [f for f in facilities if not f.get("flooded", False) and f.get("type") in ["shelter", "hospital"]]
    if not safe_targets:
        safe_targets = facilities[:3]  # fallback to any available facility

    # If no start points provided, generate points in affected zones
    if not start_points and bbox:
        center_lat = (bbox["north"] + bbox["south"]) / 2.0
        center_lon = (bbox["east"] + bbox["west"]) / 2.0
        start_points = [
            {"lat": center_lat + 0.005, "lon": center_lon + 0.005, "label": "Residential Area Alpha"},
            {"lat": center_lat - 0.006, "lon": center_lon - 0.004, "label": "East Ward Corridor"},
        ]

    routes = []
    node_list = list(G.nodes)

    for sp in (start_points or []):
        start_node = _find_nearest_node(sp["lat"], sp["lon"], node_list)
        if not start_node:
            continue

        best_route = None
        min_cost = float("inf")

        for target in safe_targets:
            target_node = _find_nearest_node(target["lat"], target["lon"], node_list)
            if not target_node or target_node == start_node:
                continue

            try:
                # Dijkstra shortest path minimizing safe travel time
                path = nx.shortest_path(G, source=start_node, target=target_node, weight="weight")
                cost = nx.shortest_path_length(G, source=start_node, target=target_node, weight="weight")

                if cost < 1e7 and cost < min_cost:
                    # Calculate actual distance & travel time
                    total_dist_m = 0.0
                    total_time_s = 0.0
                    path_coords = []

                    for i in range(len(path) - 1):
                        u, v = path[i], path[i+1]
                        edge_data = G.get_edge_data(u, v) or {}
                        total_dist_m += edge_data.get("length_m", 50.0)
                        total_time_s += edge_data.get("time_s", 5.0)
                        path_coords.append([u[1], u[0]])  # GeoJSON [lon, lat]

                    path_coords.append([path[-1][1], path[-1][0]])

                    straight_dist_m = _haversine(sp["lat"], sp["lon"], target["lat"], target["lon"])

                    best_route = {
                        "from_label": sp.get("label", "Affected Zone"),
                        "to_facility_name": target["name"],
                        "to_facility_type": target["type"],
                        "route_distance_km": round(total_dist_m / 1000.0, 2),
                        "straight_line_distance_km": round(straight_dist_m / 1000.0, 2),
                        "estimated_travel_time_min": max(3, round(total_time_s / 60.0)),
                        "path_coordinates": path_coords,
                        "road_segments_count": len(path) - 1,
                        "status": "SAFE_ALTERNATE_ROUTE",
                    }
                    min_cost = cost
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue

        if best_route:
            routes.append(best_route)

    return routes


def _find_nearest_node(lat: float, lon: float, nodes: List[Tuple[float, float]]) -> Optional[Tuple[float, float]]:
    """Find closest graph vertex to query coordinate."""
    if not nodes:
        return None
    best = None
    min_dist = float("inf")
    for n in nodes:
        d = (n[0] - lat)**2 + (n[1] - lon)**2
        if d < min_dist:
            min_dist = d
            best = n
    return best


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2
    return R * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
