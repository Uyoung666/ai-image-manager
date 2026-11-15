CREATE TABLE `library_move_candidates` (
	`photo_id` integer NOT NULL,
	`target_path_key` text NOT NULL,
	`target_path` text NOT NULL,
	`file_revision` integer NOT NULL,
	`source_missing_at` integer NOT NULL,
	`reason` text NOT NULL,
	PRIMARY KEY(`photo_id`, `target_path_key`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_library_move_target` ON `library_move_candidates` (`target_path_key`);--> statement-breakpoint
ALTER TABLE `library_refresh_jobs` ADD `request_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `library_refresh_jobs` ADD `phase` text DEFAULT 'metadata' NOT NULL;--> statement-breakpoint
ALTER TABLE `library_refresh_jobs` ADD `repair_preview` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `analysis_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER library_move_candidates_invalidate
AFTER UPDATE OF source_status, file_revision, source_missing_at, deleted_at ON photos
WHEN NEW.source_status <> 'missing' OR NEW.deleted_at IS NOT NULL
  OR NEW.file_revision IS NOT OLD.file_revision
  OR NEW.source_missing_at IS NOT OLD.source_missing_at
BEGIN
  DELETE FROM library_move_candidates WHERE photo_id = NEW.id;
END;
