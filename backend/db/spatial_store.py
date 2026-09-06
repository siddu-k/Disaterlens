"""
DisasterLens — Spatial Data Store & Caching Engine
==================================================
Provides unified persistence across PostgreSQL/PostGIS and
a local file-based SQLite spatial cache for instant offline
and expo demonstration reliability.
"""

import os
import json
import sqlite3
import hashlib
import time
from typing import Dict, Any, Optional, List
import numpy as np

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)
DB_PATH = os.path.join(CACHE_DIR, "disasterlens_cache.db")


def _init_sqlite_db():
    """Initialize local SQLite cache tables."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    cur.execute("""
        CREATE TABLE IF NOT EXISTS geodata_cache (
            bbox_hash TEXT PRIMARY KEY,
            south REAL,
            west REAL,
            north REAL,
            east REAL,
            geodata_json TEXT,
            created_at REAL
        )
    """)
    
    cur.execute("""
        CREATE TABLE IF NOT EXISTS elevation_cache (
            bbox_hash TEXT PRIMARY KEY,
            rows INTEGER,
            cols INTEGER,
            resolution_m REAL,
            min_elevation REAL,
            max_elevation REAL,
            elevation_json TEXT,
            created_at REAL
        )
    """)
    
    cur.execute("""
        CREATE TABLE IF NOT EXISTS simulation_history (
            run_uuid TEXT PRIMARY KEY,
            disaster_type TEXT,
            location_name TEXT,
            scenario_json TEXT,
            impact_json TEXT,
            timing_json TEXT,
            created_at REAL
        )
    """)
    
    conn.commit()
    conn.close()


_init_sqlite_db()


def get_bbox_hash(south: float, west: float, north: float, east: float, precision: int = 4) -> str:
    """Generate deterministic hash for spatial bounding box."""
    key = f"{round(south, precision)},{round(west, precision)},{round(north, precision)},{round(east, precision)}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def get_cached_geodata(south: float, west: float, north: float, east: float) -> Optional[Dict[str, Any]]:
    """Retrieve cached OSM geodata for bounding box if available."""
    h = get_bbox_hash(south, west, north, east)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT geodata_json FROM geodata_cache WHERE bbox_hash = ?", (h,))
    row = cur.fetchone()
    conn.close()
    if row and row[0]:
        try:
            return json.loads(row[0])
        except Exception:
            return None
    return None


def save_cached_geodata(south: float, west: float, north: float, east: float, geodata: Dict[str, Any]) -> None:
    """Save OSM geodata to cache."""
    h = get_bbox_hash(south, west, north, east)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO geodata_cache (bbox_hash, south, west, north, east, geodata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (h, south, west, north, east, json.dumps(geodata), time.time()))
    conn.commit()
    conn.close()


def get_cached_elevation(south: float, west: float, north: float, east: float) -> Optional[Dict[str, Any]]:
    """Retrieve cached elevation grid if available."""
    h = get_bbox_hash(south, west, north, east)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        SELECT rows, cols, resolution_m, min_elevation, max_elevation, elevation_json
        FROM elevation_cache WHERE bbox_hash = ?
    """, (h,))
    row = cur.fetchone()
    conn.close()
    if row and row[5]:
        try:
            elev_data = json.loads(row[5])
            return {
                "rows": row[0],
                "cols": row[1],
                "resolution_m": row[2],
                "min_elevation": row[3],
                "max_elevation": row[4],
                "elevation": np.array(elev_data, dtype=np.float64),
            }
        except Exception:
            return None
    return None


def save_cached_elevation(south: float, west: float, north: float, east: float, result: Dict[str, Any]) -> None:
    """Save elevation grid to cache."""
    h = get_bbox_hash(south, west, north, east)
    elevation_list = result["elevation"].tolist() if isinstance(result["elevation"], np.ndarray) else result["elevation"]
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO elevation_cache (bbox_hash, rows, cols, resolution_m, min_elevation, max_elevation, elevation_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        h,
        result["rows"],
        result["cols"],
        result["resolution_m"],
        float(np.nanmin(result["elevation"])),
        float(np.nanmax(result["elevation"])),
        json.dumps(elevation_list),
        time.time()
    ))
    conn.commit()
    conn.close()


def record_simulation_run(run_uuid: str, disaster_type: str, location_name: str, scenario: Dict[str, Any], impact: Dict[str, Any], timing: Dict[str, Any]) -> None:
    """Record completed simulation run for reproducibility and comparison."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO simulation_history (run_uuid, disaster_type, location_name, scenario_json, impact_json, timing_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        run_uuid,
        disaster_type,
        location_name,
        json.dumps(scenario),
        json.dumps(impact),
        json.dumps(timing),
        time.time()
    ))
    conn.commit()
    conn.close()


def get_simulation_run(run_uuid: str) -> Optional[Dict[str, Any]]:
    """Fetch recorded simulation run."""
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT disaster_type, location_name, scenario_json, impact_json, timing_json, created_at FROM simulation_history WHERE run_uuid = ?", (run_uuid,))
    row = cur.fetchone()
    conn.close()
    if row:
        return {
            "run_uuid": run_uuid,
            "disaster_type": row[0],
            "location_name": row[1],
            "scenario": json.loads(row[2]),
            "impact": json.loads(row[3]),
            "timing": json.loads(row[4]),
            "created_at": row[5],
        }
    return None
