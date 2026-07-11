ALTER TABLE photos ADD COLUMN color_bucket INTEGER;
--> statement-breakpoint
CREATE INDEX idx_photos_color_bucket ON photos(color_bucket);
