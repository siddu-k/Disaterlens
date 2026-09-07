"""
DisasterLens — Road Network Graph & Evacuation Routing Engine
=============================================================
Constructs a topological road network graph from OSM road geometries
using NetworkX. Evaluates real road accessibility under hazard closures
and computes safe evacuation routes to reachable shelters and hospitals.
"""

import math
import logging
from typing import Dict, Any, List, Tuple, Optional
import networkx as nx

logger = logging.getLogger(__name__)

SNAP_TOLERANCE_M = 500.0
_GRID_CELL_DEG = 0.01


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

            # Closed edges are excluded from the graph entirely so no
            # route can traverse them (cost<1e7 check below is belt-and-braces).
            if status == "closed":
                continue
            seg_len = _haversine(p1[0], p1[1], p2[0], p2[1])
            time_s = seg_len / speed_ms

            # Impedance weight accounting for restricted-road delays
            if status == "restricted":
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
    disaster_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Compute optimal safe evacuation paths from affected areas to reachable shelters.
    Avoids closed roads and accounts for restricted road delays.
    When disaster_type == 'wildfire', first attempts routes using only 'open'
    roads (smoke-restricted segments treated as impassable); falls back to the
    standard open+restricted network when that yields zero routes.
    """
    if disaster_type == "wildfire":
        open_only = [r for r in (roads or []) if r.get("status", "open") == "open"]
        routes = _compute_routes_on_network(open_only, facilities, start_points, bbox)
        if routes:
            return routes
    return _compute_routes_on_network(roads, facilities, start_points, bbox)


def _compute_routes_on_network(
    roads: List[Dict[str, Any]],
    facilities: List[Dict[str, Any]],
    start_points: Optional[List[Dict[str, float]]] = None,
    bbox: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
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
    grid_index = _build_grid_index(node_list)

    for sp in (start_points or []):
        start_node = _find_nearest_node(sp["lat"], sp["lon"], node_list, grid_index)
        if not start_node:
            continue
        if _haversine(sp["lat"], sp["lon"], start_node[0], start_node[1]) > SNAP_TOLERANCE_M:
            logger.info("Skipping start point %s: nearest node >500m away", sp.get("label", sp))
            continue

        best_route = None
        min_cost = float("inf")

        for target in safe_targets:
            target_node = _find_nearest_node(target["lat"], target["lon"], node_list, grid_index)
            if not target_node or target_node == start_node:
                continue
            if _haversine(target["lat"], target["lon"], target_node[0], target_node[1]) > SNAP_TOLERANCE_M:
                logger.info("Skipping target %s: nearest node >500m away", target.get("name", "?"))
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


def _build_grid_index(nodes: List[Tuple[float, float]]) -> Dict[Tuple[int, int], List[Tuple[float, float]]]:
    """Bucket graph vertices into ~0.01° cells for fast nearest lookup."""
    index: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}
    for n in nodes:
        key = (int(math.floor(n[0] / _GRID_CELL_DEG)), int(math.floor(n[1] / _GRID_CELL_DEG)))
        index.setdefault(key, []).append(n)
    return index


def _find_nearest_node(lat: float, lon: float, nodes: List[Tuple[float, float]], grid_index: Optional[Dict] = None) -> Optional[Tuple[float, float]]:
    """Find closest graph vertex to query coordinate via grid index."""
    if not nodes:
        return None
    candidates: Optional[List[Tuple[float, float]]] = None
    if grid_index:
        cx, cy = int(math.floor(lat / _GRID_CELL_DEG)), int(math.floor(lon / _GRID_CELL_DEG))
        # Expand search rings until candidates found (up to ~5 cells ≈ 5km)
        for ring in range(0, 6):
            found: List[Tuple[float, float]] = []
            for dx in range(-ring, ring + 1):
                for dy in range(-ring, ring + 1):
                    if ring and max(abs(dx), abs(dy)) != ring:
                        continue
                    found.extend(grid_index.get((cx + dx, cy + dy), []))
            if found:
                candidates = found
                break
    if candidates is None:
        candidates = nodes
    best = None
    min_dist = float("inf")
    for n in candidates:
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
