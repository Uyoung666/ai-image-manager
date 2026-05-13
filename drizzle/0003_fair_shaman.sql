CREATE TABLE `detection_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`last_photo_id` integer NOT NULL,
	`photos_processed` integer DEFAULT 0 NOT NULL,
	`pairs_found` integer DEFAULT 0 NOT NULL,
	`completed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `duplicate_pairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_a_id` integer NOT NULL,
	`photo_b_id` integer NOT NULL,
	`match_type` text NOT NULL,
	`phash_distance` integer,
	`clip_similarity` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`photo_a_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_b_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dup_pair` ON `duplicate_pairs` (`photo_a_id`,`photo_b_id`);--> statement-breakpoint
CREATE INDEX `idx_dup_status` ON `duplicate_pairs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_dup_photo_a` ON `duplicate_pairs` (`photo_a_id`);--> statement-breakpoint
CREATE INDEX `idx_dup_photo_b` ON `duplicate_pairs` (`photo_b_id`);--> statement-breakpoint
DROP INDEX `idx_exif_date_taken`;--> statement-breakpoint
CREATE INDEX `idx_exif_date_taken` ON `exif_data` (`date_taken`);--> statement-breakpoint
ALTER TABLE `photos` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `idx_photos_folder_id` ON `photos` (`folder_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_is_ai_processed` ON `photos` (`is_ai_processed`);--> statement-breakpoint
CREATE INDEX `idx_photos_file_date` ON `photos` (`file_date`);--> statement-breakpoint
CREATE INDEX `idx_photos_phash` ON `photos` (`phash`);--> statement-breakpoint
CREATE INDEX `idx_pt_photo_id` ON `photo_tags` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_pt_tag_id` ON `photo_tags` (`tag_id`);