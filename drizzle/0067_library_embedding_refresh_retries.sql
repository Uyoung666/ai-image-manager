ALTER TABLE `photos` ADD `embedding_refresh_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `embedding_refresh_retry_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `embedding_refresh_file_revision` integer;--> statement-breakpoint
CREATE TRIGGER library_embedding_refresh_gallery_revision
AFTER UPDATE OF embedding_refresh_attempts, embedding_refresh_file_revision, file_revision, is_ai_processed ON photos
WHEN (NEW.is_ai_processed = 0 AND NEW.embedding_refresh_file_revision IS NEW.file_revision AND NEW.embedding_refresh_attempts >= 4)
  <> (OLD.is_ai_processed = 0 AND OLD.embedding_refresh_file_revision IS OLD.file_revision AND OLD.embedding_refresh_attempts >= 4)
BEGIN
  UPDATE gallery_data_revision SET revision = revision + 1 WHERE id = 4;
END;--> statement-breakpoint
CREATE TRIGGER library_embedding_refresh_search_revision
AFTER UPDATE OF embedding_refresh_attempts, embedding_refresh_file_revision, file_revision, is_ai_processed ON photos
WHEN (NEW.is_ai_processed = 0 AND NEW.embedding_refresh_file_revision IS NEW.file_revision AND NEW.embedding_refresh_attempts >= 4)
  <> (OLD.is_ai_processed = 0 AND OLD.embedding_refresh_file_revision IS OLD.file_revision AND OLD.embedding_refresh_attempts >= 4)
BEGIN
  UPDATE search_data_revision SET revision = revision + 1 WHERE id = 1;
END;
