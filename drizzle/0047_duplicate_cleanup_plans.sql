CREATE TABLE `duplicate_cleanup_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` text,
	`batch_id` text,
	`event_type` text NOT NULL,
	`photo_id` integer,
	`details_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_event_plan` ON `duplicate_cleanup_events` (`plan_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_event_batch` ON `duplicate_cleanup_events` (`batch_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_event_photo` ON `duplicate_cleanup_events` (`photo_id`);--> statement-breakpoint
CREATE TABLE `duplicate_cleanup_plan_items` (
	`plan_id` text NOT NULL,
	`group_key` text NOT NULL,
	`group_version` text NOT NULL,
	`review_revision` integer NOT NULL,
	`photo_id` integer NOT NULL,
	`decision` text NOT NULL,
	`content_revision` integer NOT NULL,
	`path` text NOT NULL,
	`file_size` integer NOT NULL,
	`modified_at` real NOT NULL,
	`file_identity` text,
	`full_sha256` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`plan_id`, `group_key`, `photo_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `duplicate_cleanup_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_plan_item_photo` ON `duplicate_cleanup_plan_items` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_plan_item_group` ON `duplicate_cleanup_plan_items` (`plan_id`,`group_key`);--> statement-breakpoint
CREATE TABLE `duplicate_cleanup_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'READY' NOT NULL,
	`expires_at` integer NOT NULL,
	`batch_id` text,
	`executed_at` integer,
	`deleted_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_plan_status` ON `duplicate_cleanup_plans` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_duplicate_cleanup_plan_batch` ON `duplicate_cleanup_plans` (`batch_id`);