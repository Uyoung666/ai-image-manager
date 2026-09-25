CREATE TABLE `duplicate_detection_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`algorithm_version` text NOT NULL,
	`hash_version` text NOT NULL,
	`phash_version` text NOT NULL,
	`phash_threshold` real NOT NULL,
	`embedding_model_version` text,
	`embedding_threshold` real,
	`threshold_profile_version` text NOT NULL,
	`photo_revision` text NOT NULL,
	`sequence_revision` integer NOT NULL,
	`vector_revision` text NOT NULL,
	`settings_revision` text NOT NULL,
	`config_fingerprint` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_detection_run_status` ON `duplicate_detection_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_detection_run_config` ON `duplicate_detection_runs` (`config_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_detection_run_started` ON `duplicate_detection_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `duplicate_run_groups` (
	`run_id` text NOT NULL,
	`group_key` text NOT NULL,
	`group_version` text NOT NULL,
	`match_type` text NOT NULL,
	`recommended_keep_id` integer NOT NULL,
	`member_ids_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `group_key`),
	FOREIGN KEY (`run_id`) REFERENCES `duplicate_detection_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_run_group_key` ON `duplicate_run_groups` (`group_key`);--> statement-breakpoint
CREATE TABLE `duplicate_run_members` (
	`run_id` text NOT NULL,
	`group_key` text NOT NULL,
	`photo_id` integer NOT NULL,
	`content_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `group_key`, `photo_id`),
	FOREIGN KEY (`run_id`) REFERENCES `duplicate_detection_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_run_member_photo` ON `duplicate_run_members` (`photo_id`);--> statement-breakpoint
CREATE TABLE `duplicate_run_pairs` (
	`run_id` text NOT NULL,
	`photo_a_id` integer NOT NULL,
	`photo_b_id` integer NOT NULL,
	`match_type` text NOT NULL,
	`phash_distance` integer,
	`clip_similarity` real,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `photo_a_id`, `photo_b_id`),
	FOREIGN KEY (`run_id`) REFERENCES `duplicate_detection_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_run_pair_photo_a` ON `duplicate_run_pairs` (`photo_a_id`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_run_pair_photo_b` ON `duplicate_run_pairs` (`photo_b_id`);