ALTER TABLE `photos` ADD `face_refresh_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `face_refresh_retry_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER library_face_refresh_gallery_revision
AFTER UPDATE OF face_refresh_pending, face_refresh_attempts, face_processing_error ON photos
WHEN NEW.face_refresh_pending IS NOT OLD.face_refresh_pending
  OR (NEW.face_refresh_attempts >= 4) <> (OLD.face_refresh_attempts >= 4)
  OR NEW.face_processing_error IS NOT OLD.face_processing_error
BEGIN
  UPDATE gallery_data_revision SET revision = revision + 1 WHERE id = 4;
END;--> statement-breakpoint
CREATE TRIGGER library_face_refresh_search_revision
AFTER UPDATE OF face_refresh_pending, face_refresh_attempts, face_processing_error ON photos
WHEN NEW.face_refresh_pending IS NOT OLD.face_refresh_pending
  OR (NEW.face_refresh_attempts >= 4) <> (OLD.face_refresh_attempts >= 4)
  OR NEW.face_processing_error IS NOT OLD.face_processing_error
BEGIN
  UPDATE search_data_revision SET revision = revision + 1 WHERE id = 1;
END;
