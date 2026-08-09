-- Compensation migration for the historical, unregistered 0017 FTS5 file.
-- The historical table declared photos as external content even though the
-- camera/lens columns live in exif_data. Recreate the derived index with a
-- dedicated external-content table so FTS5 can rebuild and delete safely.
DROP TRIGGER IF EXISTS photos_fts_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS photos_fts_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS photos_fts_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS exif_fts_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS exif_fts_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS exif_fts_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS photos_fts_hard_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS photos_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS photo_search_source;
--> statement-breakpoint
CREATE TABLE photo_search_source (
  id INTEGER PRIMARY KEY NOT NULL,
  filename TEXT NOT NULL,
  camera_model TEXT NOT NULL DEFAULT '',
  lens_model TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE VIRTUAL TABLE photos_fts USING fts5(
  filename,
  camera_model,
  lens_model,
  content=photo_search_source,
  content_rowid=id
);
--> statement-breakpoint

-- Populate active rows from the normalized source tables. Soft-deleted rows
-- are intentionally excluded from the derived index.
INSERT INTO photo_search_source(id, filename, camera_model, lens_model)
SELECT
  p.id,
  p.filename,
  COALESCE(e.camera_model, ''),
  COALESCE(e.lens_model, '')
FROM photos p
LEFT JOIN exif_data e ON e.photo_id = p.id
WHERE p.deleted_at IS NULL;
--> statement-breakpoint
INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');
--> statement-breakpoint

CREATE TRIGGER photos_fts_insert AFTER INSERT ON photos
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT NEW.id, NEW.filename, COALESCE(e.camera_model, ''), COALESCE(e.lens_model, '')
  FROM exif_data e
  WHERE e.photo_id = NEW.id;
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT NEW.id, NEW.filename, '', ''
  WHERE NOT EXISTS (SELECT 1 FROM exif_data WHERE photo_id = NEW.id);
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER photos_fts_update AFTER UPDATE OF filename, deleted_at ON photos
BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, filename, camera_model, lens_model)
  SELECT 'delete', id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = OLD.id AND OLD.deleted_at IS NULL;
  DELETE FROM photo_search_source
  WHERE id = OLD.id AND OLD.deleted_at IS NULL;

  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT NEW.id, NEW.filename, COALESCE(e.camera_model, ''), COALESCE(e.lens_model, '')
  FROM exif_data e
  WHERE NEW.deleted_at IS NULL AND e.photo_id = NEW.id;
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT NEW.id, NEW.filename, '', ''
  WHERE NEW.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM exif_data WHERE photo_id = NEW.id);
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.id AND NEW.deleted_at IS NULL;
END;
--> statement-breakpoint

CREATE TRIGGER photos_fts_hard_delete AFTER DELETE ON photos
BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, filename, camera_model, lens_model)
  SELECT 'delete', id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = OLD.id;
  DELETE FROM photo_search_source WHERE id = OLD.id;
END;
--> statement-breakpoint

CREATE TRIGGER exif_fts_insert AFTER INSERT ON exif_data
WHEN EXISTS (SELECT 1 FROM photos WHERE id = NEW.photo_id AND deleted_at IS NULL)
BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, filename, camera_model, lens_model)
  SELECT 'delete', id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.photo_id;
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT p.id, p.filename, COALESCE(NEW.camera_model, ''), COALESCE(NEW.lens_model, '')
  FROM photos p
  WHERE p.id = NEW.photo_id;
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.photo_id;
END;
--> statement-breakpoint

CREATE TRIGGER exif_fts_update AFTER UPDATE ON exif_data
WHEN EXISTS (SELECT 1 FROM photos WHERE id = NEW.photo_id AND deleted_at IS NULL)
BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, filename, camera_model, lens_model)
  SELECT 'delete', id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.photo_id;
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT p.id, p.filename, COALESCE(NEW.camera_model, ''), COALESCE(NEW.lens_model, '')
  FROM photos p
  WHERE p.id = NEW.photo_id;
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = NEW.photo_id;
END;
--> statement-breakpoint

CREATE TRIGGER exif_fts_delete AFTER DELETE ON exif_data
WHEN EXISTS (SELECT 1 FROM photos WHERE id = OLD.photo_id AND deleted_at IS NULL)
BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, filename, camera_model, lens_model)
  SELECT 'delete', id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = OLD.photo_id;
  INSERT OR REPLACE INTO photo_search_source(id, filename, camera_model, lens_model)
  SELECT p.id, p.filename, '', ''
  FROM photos p
  WHERE p.id = OLD.photo_id;
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT id, filename, camera_model, lens_model
  FROM photo_search_source
  WHERE id = OLD.photo_id;
END;
