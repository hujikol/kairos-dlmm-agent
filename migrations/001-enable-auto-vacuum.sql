PRAGMA auto_vacuum = INCREMENTAL;

-- Position state machine: add status column
ALTER TABLE positions ADD COLUMN status TEXT DEFAULT 'active';
