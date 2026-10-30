CREATE TABLE `shooting_project_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`filename` text NOT NULL,
	`file_size` integer NOT NULL,
	`modified_at` integer NOT NULL,
	`date_taken` integer,
	`format` text NOT NULL,
	`width` integer,
	`height` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_status` text DEFAULT 'unverified' NOT NULL,
	`lightweight_fingerprint` text,
	`content_hash` text,
	`preview_relative_path` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `shooting_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shooting_project_photos_path` ON `shooting_project_photos` (`project_id`,`relative_path`);--> statement-breakpoint
CREATE INDEX `idx_shooting_project_photos_status` ON `shooting_project_photos` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `shooting_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_root` text NOT NULL,
	`source_status` text NOT NULL,
	`source_checked_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`archived_at` integer,
	`current_photo_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_shooting_projects_recent` ON `shooting_projects` (`archived_at`,`last_opened_at`);