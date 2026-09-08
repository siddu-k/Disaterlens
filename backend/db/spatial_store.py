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
import logging
from typing import Dict, Any, Optional, List
import numpy as np

logger = logging.getLogger(__name__)

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)
DB_PATH = os.path.join(CACHE_DIR, "disasterlens_cache.db")


def _connect() -> sqlite3.Connection:
    """
    Open a hardened SQLite connection: 30s busy timeout and WAL journal mode
    for concurrent read/write safety. Callers must close it (use try/finally).
    Row handling is unchanged from before (default tuple rows).
    """
    conn = sqlite3.connect(DB_PATH, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    return conn


def _ensure_created_at_columns(conn: sqlite3.Connection) -> None:
    """Add a created_at column to legacy cache tables that predate it (guarded)."""
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing_tables = {row[0] for row in cur.fetchall()}
    for table in ("geodata_cache", "elevation_cache", "simulation_history"):
        if table not in existing_tables:
            continue
        cur.execute(f"PRAGMA table_info({table})")
        columns = {row[1] for row in cur.fetchall()}
        if "created_at" not in columns:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN created_at REAL")


def _init_sqlite_db():
    """Initialize local SQLite cache tables."""
    conn = _connect()
    try:
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

        cur.execute("""
            CREATE TABLE IF NOT EXISTS satvision_snapshots (
                id TEXT PRIMARY KEY,
                created_at TEXT,
                bbox_hash TEXT,
                bbox_json TEXT,
                payload_json TEXT
            )
        """)

        _ensure_created_at_columns(conn)

        conn.commit()
    finally:
        conn.close()


try:
    _init_sqlite_db()
except Exception as e:
    logger.warning(f"[SpatialStore] Best-effort DB init notice: {e}")


def get_bbox_hash(
    south: float,
    west: float,
    north: float,
    east: float,
    precision: int = 4,
    resolution_m: Optional[float] = None,
    rows: Optional[int] = None,
    cols: Optional[int] = None,
) -> str:
    """
    Generate deterministic hash for spatial bounding box.
    Optional resolution_m/rows/cols segments make the key resolution-aware
    when those params are available at the call site; omitted (None) segments
    are excluded so existing callers produce identical hashes to before.
    """
    key = f"{round(south, precision)},{round(west, precision)},{round(north, precision)},{round(east, precision)}"
    if resolution_m is not None:
        key += f"|res={resolution_m}"
    if rows is not None:
        key += f"|rows={rows}"
    if cols is not None:
        key += f"|cols={cols}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def purge_old_cache(max_age_days: float = 30) -> int:
    """Delete cache rows older than max_age_days from the spatial cache tables."""
    cutoff = time.time() - max_age_days * 86400.0
    total = 0
    conn = _connect()
    try:
        cur = conn.cursor()
        for table in ("geodata_cache", "elevation_cache"):
            try:
                cur.execute(f"DELETE FROM {table} WHERE created_at IS NOT NULL AND created_at < ?", (cutoff,))
                total += cur.rowcount or 0
            except Exception as e:
                logger.warning(f"[SpatialStore] Purge notice ({table}): {e}")
        conn.commit()
    finally:
        conn.close()
    return total


def _purge_old_cache_best_effort() -> None:
    """Lazily purge expired cache rows on write; never fail the write path."""
    try:
        purge_old_cache()
    except Exception as e:
        logger.warning(f"[SpatialStore] Lazy purge notice: {e}")


def get_cached_geodata(south: float, west: float, north: float, east: float) -> Optional[Dict[str, Any]]:
    """Retrieve cached OSM geodata for bounding box if available."""
    h = get_bbox_hash(south, west, north, east)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("SELECT geodata_json FROM geodata_cache WHERE bbox_hash = ?", (h,))
        row = cur.fetchone()
    finally:
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
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT OR REPLACE INTO geodata_cache (bbox_hash, south, west, north, east, geodata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (h, south, west, north, east, json.dumps(geodata), time.time()))
        conn.commit()
    finally:
        conn.close()
    _purge_old_cache_best_effort()


def get_cached_elevation(
    south: float,
    west: float,
    north: float,
    east: float,
    resolution_m: Optional[float] = None,
    rows: Optional[int] = None,
    cols: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Retrieve cached elevation grid if available (resolution-aware when params given)."""
    h = get_bbox_hash(south, west, north, east, resolution_m=resolution_m, rows=rows, cols=cols)
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT rows, cols, resolution_m, min_elevation, max_elevation, elevation_json
            FROM elevation_cache WHERE bbox_hash = ?
        """, (h,))
        row = cur.fetchone()
    finally:
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
    h = get_bbox_hash(
        south, west, north, east,
        resolution_m=result.get("resolution_m"),
        rows=result.get("rows"),
        cols=result.get("cols"),
    )
    elevation_list = result["elevation"].tolist() if isinstance(result["elevation"], np.ndarray) else result["elevation"]
    conn = _connect()
    try:
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
    finally:
        conn.close()
    _purge_old_cache_best_effort()


def record_simulation_run(run_uuid: str, disaster_type: str, location_name: str, scenario: Dict[str, Any], impact: Dict[str, Any], timing: Dict[str, Any]) -> None:
    """Record completed simulation run for reproducibility and comparison."""
    conn = _connect()
    try:
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
    finally:
        conn.close()


def get_simulation_run(run_uuid: str) -> Optional[Dict[str, Any]]:
    """Fetch recorded simulation run."""
    conn = _connect()
    try:
        cur = conn.cursor()
        cur.execute("SELECT disaster_type, location_name, scenario_json, impact_json, timing_json, created_at FROM simulation_history WHERE run_uuid = ?", (run_uuid,))
        row = cur.fetchone()
    finally:
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


def _ensure_satvision_table(conn: sqlite3.Connection) -> None:
    """Guarded DDL for the satellite-vision snapshot table (additive)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS satvision_snapshots (
            id TEXT PRIMARY KEY,
            created_at TEXT,
            bbox_hash TEXT,
            bbox_json TEXT,
            payload_json TEXT
        )
    """)


def save_satvision_snapshot(snapshot_id: str, bbox: Dict[str, Any], payload: Dict[str, Any]) -> None:
    """Persist a satellite-vision detection snapshot."""
    import datetime as _dt
    h = get_bbox_hash(
        float(bbox["south"]), float(bbox["west"]),
        float(bbox["north"]), float(bbox["east"]),
    )
    conn = _connect()
    try:
        _ensure_satvision_table(conn)
        conn.execute(
            "INSERT OR REPLACE INTO satvision_snapshots (id, created_at, bbox_hash, bbox_json, payload_json)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                snapshot_id,
                _dt.datetime.now(_dt.timezone.utc).isoformat(),
                h,
                json.dumps(bbox),
                json.dumps(payload),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def list_satvision_snapshots(bbox: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """List snapshots (latest 20); filter by bbox_hash when a bbox is given."""
    conn = _connect()
    try:
        _ensure_satvision_table(conn)
        cur = conn.cursor()
        if bbox is not None:
            h = get_bbox_hash(
                float(bbox["south"]), float(bbox["west"]),
                float(bbox["north"]), float(bbox["east"]),
            )
            cur.execute(
                "SELECT id, created_at, bbox_json FROM satvision_snapshots"
                " WHERE bbox_hash = ? ORDER BY created_at DESC LIMIT 20",
                (h,),
            )
        else:
            cur.execute(
                "SELECT id, created_at, bbox_json FROM satvision_snapshots"
                " ORDER BY created_at DESC LIMIT 20"
            )
        rows = cur.fetchall()
    finally:
        conn.close()
    out: List[Dict[str, Any]] = []
    for row in rows:
        try:
            parsed_bbox = json.loads(row[2]) if row[2] else None
        except Exception:
            parsed_bbox = None
        out.append({"id": row[0], "created_at": row[1], "bbox": parsed_bbox})
    return out


def get_satvision_snapshot(snapshot_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a satellite-vision snapshot payload by id (None when missing)."""
    conn = _connect()
    try:
        _ensure_satvision_table(conn)
        cur = conn.cursor()
        cur.execute(
            "SELECT id, created_at, bbox_json, payload_json FROM satvision_snapshots WHERE id = ?",
            (snapshot_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return None
    try:
        payload = json.loads(row[3]) if row[3] else {}
    except Exception:
        payload = {}
    try:
        bbox = json.loads(row[2]) if row[2] else None
    except Exception:
        bbox = None
    result: Dict[str, Any] = {"id": row[0], "created_at": row[1], "bbox": bbox}
    if isinstance(payload, dict):
        result.update(payload)
    else:
        result["payload"] = payload
    return result
