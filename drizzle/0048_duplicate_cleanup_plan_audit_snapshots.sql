PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_duplicate_cleanup_plan_items` (
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
	FOREIGN KEY (`plan_id`) REFERENCES `duplicate_cleanup_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_duplicate_cleanup_plan_items`("plan_id", "group_key", "group_version", "review_revision", "photo_id", "decision", "content_revision", "path", "file_size", "modified_at", "file_identity", "full_sha256", "created_at") SELECT "plan_id", "group_key", "group_version", "review_revision", "photo_id", "decision", "content_revision", "path", "file_size", "modified_at", "file_identity", "full_sha256", "created_at" FROM `duplicate_cleanup_plan_items`;--> statement-breakpoint
DROP TABLE `duplicate_cleanup_plan_items`;--> statement-breakpoint
ALTER TABLE `__new_duplicate_cleanup_plan_items` RENAME TO `duplicate_cleanup_plan_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_plan_item_photo` ON `duplicate_cleanup_plan_items` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_cleanup_plan_item_group` ON `duplicate_cleanup_plan_items` (`plan_id`,`group_key`);