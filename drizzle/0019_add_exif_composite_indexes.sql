-- Composite indexes for common multi-filter queries
CREATE INDEX idx_exif_camera_date ON exif_data(camera_model, date_taken);--> statement-breakpoint
CREATE INDEX idx_exif_iso_aperture ON exif_data(iso, aperture);--> statement-breakpoint
CREATE INDEX idx_exif_focal_aperture ON exif_data(focal_length_num, aperture);--> statement-breakpoint
CREATE INDEX idx_exif_shutter_iso ON exif_data(shutter_speed_num, iso);
