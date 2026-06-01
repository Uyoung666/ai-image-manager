ALTER TABLE photos ADD COLUMN is_face_processed INTEGER NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX idx_photos_is_face_processed ON photos (is_face_processed);--> statement-breakpoint
UPDATE photos SET is_face_processed = 1
WHERE id IN (SELECT DISTINCT photo_id FROM face_vectors);
