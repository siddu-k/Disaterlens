-- ==========================================================
-- DisasterLens PostGIS Database Schema
-- Multi-Hazard Disaster Simulation & Impact Analysis Platform
-- ==========================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Area of Interest (AOI)
CREATE TABLE IF NOT EXISTS aoi (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    name VARCHAR(255) NOT NULL,
    geom GEOMETRY(Polygon, 4326) NOT NULL,
    south DOUBLE PRECISION NOT NULL,
    west DOUBLE PRECISION NOT NULL,
    north DOUBLE PRECISION NOT NULL,
    east DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_aoi_geom ON aoi USING GIST (geom);

-- 2. Road Network (OSM Highways)
CREATE TABLE IF NOT EXISTS roads (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    osm_id BIGINT,
    name VARCHAR(255),
    highway_type VARCHAR(64) NOT NULL,
    geom GEOMETRY(LineString, 4326) NOT NULL,
    length_m DOUBLE PRECISION NOT NULL,
    oneway BOOLEAN DEFAULT FALSE,
    maxspeed INTEGER DEFAULT 50,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_roads_geom ON roads USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_roads_aoi ON roads (aoi_id);

-- 3. Building Footprints
CREATE TABLE IF NOT EXISTS buildings (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    osm_id BIGINT,
    name VARCHAR(255),
    building_type VARCHAR(64) DEFAULT 'residential',
    geom GEOMETRY(Geometry, 4326) NOT NULL,
    centroid GEOMETRY(Point, 4326),
    area_sqm DOUBLE PRECISION,
    estimated_occupants INTEGER DEFAULT 10,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_buildings_geom ON buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_centroid ON buildings USING GIST (centroid);
CREATE INDEX IF NOT EXISTS idx_buildings_aoi ON buildings (aoi_id);

-- 4. Critical & Emergency Facilities
CREATE TABLE IF NOT EXISTS facilities (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    osm_id BIGINT,
    name VARCHAR(255) NOT NULL,
    facility_type VARCHAR(64) NOT NULL, -- 'hospital', 'shelter', 'police', 'fire_station', 'school'
    geom GEOMETRY(Point, 4326) NOT NULL,
    capacity INTEGER DEFAULT 100,
    contact_info VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_facilities_geom ON facilities USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_facilities_type ON facilities (facility_type);

-- 5. Waterways & Water Bodies
CREATE TABLE IF NOT EXISTS waterways (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    osm_id BIGINT,
    name VARCHAR(255),
    water_type VARCHAR(64) DEFAULT 'river',
    geom GEOMETRY(Geometry, 4326) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_waterways_geom ON waterways USING GIST (geom);

-- 6. Digital Elevation Models (DEM Metadata & Raster storage)
CREATE TABLE IF NOT EXISTS dem_metadata (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    source_dataset VARCHAR(128) DEFAULT 'Copernicus DEM 30m / SRTM',
    resolution_m DOUBLE PRECISION DEFAULT 30.0,
    rows INTEGER NOT NULL,
    cols INTEGER NOT NULL,
    min_elevation DOUBLE PRECISION,
    max_elevation DOUBLE PRECISION,
    raster_storage_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Population Grids (WorldPop or high-res raster exposure)
CREATE TABLE IF NOT EXISTS population_grids (
    id SERIAL PRIMARY KEY,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE CASCADE,
    source_dataset VARCHAR(128) DEFAULT 'WorldPop 100m Resolution Grid',
    resolution_m DOUBLE PRECISION DEFAULT 100.0,
    total_population INTEGER,
    raster_storage_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Simulation Runs
CREATE TABLE IF NOT EXISTS simulation_runs (
    id SERIAL PRIMARY KEY,
    run_uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    aoi_id INTEGER REFERENCES aoi(id) ON DELETE SET NULL,
    disaster_type VARCHAR(64) NOT NULL, -- 'flood', 'earthquake', 'wildfire', 'landslide', 'cyclone'
    model_name VARCHAR(128) NOT NULL,
    model_version VARCHAR(32) NOT NULL,
    scenario_parameters JSONB NOT NULL,
    status VARCHAR(32) DEFAULT 'completed',
    execution_time_s DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sim_runs_type ON simulation_runs (disaster_type);

-- 9. Simulation Timesteps
CREATE TABLE IF NOT EXISTS simulation_timesteps (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES simulation_runs(id) ON DELETE CASCADE,
    timestep_index INTEGER NOT NULL,
    time_elapsed_hours DOUBLE PRECISION NOT NULL,
    hazard_raster_path TEXT,
    summary_metrics JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timesteps_run ON simulation_timesteps (run_id);

-- 10. Impact Results
CREATE TABLE IF NOT EXISTS impact_results (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES simulation_runs(id) ON DELETE CASCADE,
    affected_area_km2 DOUBLE PRECISION NOT NULL,
    estimated_population_exposed INTEGER NOT NULL,
    buildings_affected INTEGER NOT NULL,
    total_buildings INTEGER NOT NULL,
    roads_open_count INTEGER NOT NULL,
    roads_restricted_count INTEGER NOT NULL,
    roads_closed_count INTEGER NOT NULL,
    roads_open_km DOUBLE PRECISION NOT NULL,
    roads_restricted_km DOUBLE PRECISION NOT NULL,
    roads_closed_km DOUBLE PRECISION NOT NULL,
    critical_facilities_at_risk INTEGER NOT NULL,
    safe_facilities_count INTEGER NOT NULL,
    evacuation_routes_summary JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Data Provenance & Evidence Records
CREATE TABLE IF NOT EXISTS provenance_metadata (
    id SERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES simulation_runs(id) ON DELETE CASCADE,
    dataset_name VARCHAR(255) NOT NULL,
    provider VARCHAR(255) NOT NULL,
    source_url TEXT,
    acquisition_date VARCHAR(64),
    spatial_resolution VARCHAR(64),
    processing_date VARCHAR(64),
    confidence_level VARCHAR(64) DEFAULT 'High',
    license VARCHAR(128)
);
