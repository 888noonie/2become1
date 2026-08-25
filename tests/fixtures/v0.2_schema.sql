-- V0.2 database schema fixture for migration tests.
--
-- This reproduces the exact schema that StudioService._init_db produced at
-- V0.2 (commit b11d61d / b239275): the `tracks` and `jobs` tables with the
-- beat-grid and source-provenance columns, and WITHOUT any V0.3 columns or
-- the `schema_migrations` table.
--
-- Migration tests apply this to a fresh in-memory/temp database, run
-- migrations.run_migrations(), and assert that (a) the V0.3 columns and
-- tables appear, and (b) the seeded rows survive intact.

CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    bpm REAL NOT NULL,
    tonic TEXT NOT NULL,
    mode TEXT NOT NULL,
    confidence REAL NOT NULL,
    duration REAL NOT NULL,
    beat_interval REAL,
    first_beat REAL,
    suggested_downbeat REAL,
    beat_confidence REAL,
    source_kind TEXT NOT NULL DEFAULT 'upload',
    source_ref TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL,
    message TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT,
    output_path TEXT,
    error TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Seed rows that must survive migration unchanged.
INSERT INTO tracks
    (id, original_name, path, size_bytes, bpm, tonic, mode, confidence,
     duration, beat_interval, first_beat, suggested_downbeat, beat_confidence,
     source_kind, source_ref, created_at)
VALUES
    ('track-v02-1', 'anchor.wav', '/data/tracks/track-v02-1.wav', 529244,
     100.6, 'C', 'major', 0.62, 6.0, 0.5964, 0.0, 0.596, 1.0,
     'local', '/tmp/anchor.wav', 1787658168.0);

INSERT INTO jobs
    (id, kind, status, stage, progress, message, request_json, result_json,
     output_path, error, created_at, updated_at)
VALUES
    ('job-v02-1', 'preview', 'complete', 'complete', 100, 'Your preview is ready',
     '{"anchor_id":"track-v02-1","lead_id":"track-v02-1","preview":true}',
     '{"tempo_ratio":1.0,"semitone_shift":0}', '/data/renders/job-v02-1.mp3',
     NULL, 1787658178.0, 1787658179.0);
