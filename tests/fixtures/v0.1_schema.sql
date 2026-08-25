-- V0.1 database schema fixture for migration tests.
--
-- This reproduces the schema that StudioService._init_db produced at V0.1
-- (commit 0c89a2e / 015e0c8): the `tracks` and `jobs` tables WITHOUT the
-- beat-grid columns (beat_interval, first_beat, suggested_downbeat,
-- beat_confidence) and WITHOUT source provenance (source_kind, source_ref).
--
-- Migration #0 must add those columns; migrations #1-#3 then add the V0.3
-- columns and tables. The seeded row must survive the full chain intact.

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

INSERT INTO tracks
    (id, original_name, path, size_bytes, bpm, tonic, mode, confidence,
     duration, created_at)
VALUES
    ('track-v01-1', 'old.wav', '/data/tracks/track-v01-1.wav', 1000,
     120.0, 'G', 'major', 0.5, 5.0, 1700000000.0);

INSERT INTO jobs
    (id, kind, status, stage, progress, message, request_json, result_json,
     output_path, error, created_at, updated_at)
VALUES
    ('job-v01-1', 'render', 'complete', 'complete', 100, 'done',
     '{"anchor_id":"track-v01-1"}', '{"tempo_ratio":1.0}', '/data/renders/job-v01-1.mp3',
     NULL, 1700000000.0, 1700000001.0);
