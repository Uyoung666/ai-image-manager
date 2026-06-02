-- Create FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
  filename,
  camera_model,
  lens_model,
  content=photos,
  content_rowid=id
);
--> statement-breakpoint
-- Populate FTS5 table with existing data
INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
SELECT
  p.id,
  p.filename,
  COALESCE(e.camera_model, ''),
  COALESCE(e.lens_model, '')
FROM photos p
LEFT JOIN exif_data e ON p.id = e.photo_id
WHERE p.deleted_at IS NULL;
--> statement-breakpoint
-- Trigger: sync FTS5 on insert
CREATE TRIGGER IF NOT EXISTS photos_fts_insert AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, filename, camera_model, lens_model)
  SELECT
    NEW.id,
    NEW.filename,
    COALESCE(e.camera_model, ''),
    COALESCE(e.lens_model, '')
  FROM photos p
  LEFT JOIN exif_data e ON p.id = e.photo_id
  WHERE p.id = NEW.id;
END;
--> statement-breakpoint
-- Trigger: sync FTS5 on update
CREATE TRIGGER IF NOT EXISTS photos_fts_update AFTER UPDATE ON photos BEGIN
  UPDATE photos_fts
  SET
    filename = NEW.filename
  WHERE rowid = NEW.id;
END;
--> statement-breakpoint
-- Trigger: sync FTS5 on delete (soft delete)
CREATE TRIGGER IF NOT EXISTS photos_fts_delete AFTER UPDATE OF deleted_at ON photos BEGIN
  DELETE FROM photos_fts WHERE rowid = NEW.id AND NEW.deleted_at IS NOT NULL;
END;
--> statement-breakpoint
-- Trigger: sync FTS5 when exif is inserted/updated
CREATE TRIGGER IF NOT EXISTS exif_fts_insert AFTER INSERT ON exif_data BEGIN
  UPDATE photos_fts
  SET
    camera_model = COALESCE(NEW.camera_model, ''),
    lens_model = COALESCE(NEW.lens_model, '')
  WHERE rowid = NEW.photo_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS exif_fts_update AFTER UPDATE ON exif_data BEGIN
  UPDATE photos_fts
  SET
    camera_model = COALESCE(NEW.camera_model, ''),
    lens_model = COALESCE(NEW.lens_model, '')
  WHERE rowid = NEW.photo_id;
END;
