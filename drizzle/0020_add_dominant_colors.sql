ALTER TABLE photos ADD COLUMN dominant_colors TEXT;--> statement-breakpoint
INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('colors_migrated', 'false', unixepoch() * 1000);
