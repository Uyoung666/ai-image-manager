-- Add numeric columns for EXIF range queries to avoid CAST overhead
ALTER TABLE exif_data ADD COLUMN focal_length_num REAL;--> statement-breakpoint
ALTER TABLE exif_data ADD COLUMN shutter_speed_num REAL;--> statement-breakpoint

-- Migrate existing data
UPDATE exif_data SET focal_length_num = CAST(focal_length AS REAL) WHERE focal_length IS NOT NULL;--> statement-breakpoint
UPDATE exif_data SET shutter_speed_num = CAST(shutter_speed AS REAL) WHERE shutter_speed IS NOT NULL;--> statement-breakpoint

-- Add indexes on new numeric columns
CREATE INDEX idx_exif_focal_length_num ON exif_data(focal_length_num);--> statement-breakpoint
CREATE INDEX idx_exif_shutter_speed_num ON exif_data(shutter_speed_num);
