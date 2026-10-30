CREATE TABLE `shooting_project_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `shooting_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shooting_project_actions_project` ON `shooting_project_actions` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `shooting_project_output_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`source_path` text NOT NULL,
	`target_path` text NOT NULL,
	`temp_path` text NOT NULL,
	`file_size` integer NOT NULL,
	`modified_at` real NOT NULL,
	`lightweight_fingerprint` text,
	`source_hash` text,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`copied_bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`task_id`) REFERENCES `shooting_project_outputs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shooting_project_output_items_task` ON `shooting_project_output_items` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shooting_project_output_items_target` ON `shooting_project_output_items` (`task_id`,`target_path`);--> statement-breakpoint
CREATE TABLE `shooting_project_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_root` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `shooting_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shooting_project_outputs_project` ON `shooting_project_outputs` (`project_id`);--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `preview_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `preview_width` integer;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `preview_height` integer;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `preview_error` text;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `preview_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `browsing_json` text;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `scan_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `scan_kind` text DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `scan_errors_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `initial_scan_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `previews_cleared` integer DEFAULT false NOT NULL;