CREATE TABLE `library_refresh_jobs` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`content_revision` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `cull_session_photos` ADD `content_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `face_vectors` ADD `content_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `source_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `source_checked_at` integer;--> statement-breakpoint
ALTER TABLE `folders` ADD `last_scan_result` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_status` text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_checked_at` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_available_at` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_missing_at` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_error_code` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_size` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_mtime_ms` real;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_ctime_ms` real;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_hash` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_hash_version` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_hash_file_revision` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `file_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `content_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `metadata_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `embedding_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `color_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `refresh_status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `refresh_error` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `deletion_source_hash` text;--> statement-breakpoint
CREATE INDEX `idx_photos_source_status` ON `photos` (`source_status`);--> statement-breakpoint
CREATE INDEX `idx_photos_source_hash` ON `photos` (`source_size`,`source_hash`);--> statement-breakpoint
INSERT INTO gallery_data_revision (id, revision) VALUES (4, 0);--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_source_update
AFTER UPDATE OF source_status, refresh_status, embedding_revision, content_revision ON photos
WHEN NEW.source_status IS NOT OLD.source_status OR NEW.refresh_status IS NOT OLD.refresh_status
  OR (NEW.embedding_revision <> NEW.content_revision) <> (OLD.embedding_revision <> OLD.content_revision)
BEGIN
  UPDATE gallery_data_revision SET revision = revision + 1 WHERE id = 4;
END;--> statement-breakpoint
CREATE TRIGGER search_revision_photo_source_update
AFTER UPDATE OF source_status, refresh_status, content_revision, embedding_revision, color_revision ON photos
WHEN NEW.source_status IS NOT OLD.source_status OR NEW.refresh_status IS NOT OLD.refresh_status
  OR NEW.content_revision IS NOT OLD.content_revision OR NEW.embedding_revision IS NOT OLD.embedding_revision
  OR NEW.color_revision IS NOT OLD.color_revision
BEGIN
  UPDATE search_data_revision SET revision = revision + 1 WHERE id = 1;
END;--> statement-breakpoint
CREATE TRIGGER library_snapshot_deletion_identity
AFTER UPDATE OF deleted_at ON photos
WHEN (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
BEGIN
  UPDATE photos SET deletion_source_hash = CASE
    WHEN NEW.deleted_at IS NOT NULL AND NEW.source_hash_version = 'sha256-full-v1'
      AND NEW.source_hash_file_revision = NEW.file_revision
    THEN NEW.source_hash ELSE NULL END
  WHERE id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER library_snapshot_cull_content
AFTER INSERT ON cull_session_photos
WHEN NEW.photo_id IS NOT NULL
BEGIN
  UPDATE cull_session_photos SET content_revision =
    (SELECT content_revision FROM photos WHERE id = NEW.photo_id)
  WHERE id = NEW.id;
END;
