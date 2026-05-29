CREATE TABLE `cull_action_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cull_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cal_session_id` ON `cull_action_logs` (`session_id`);--> statement-breakpoint
CREATE TABLE `cull_session_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`photo_id` integer NOT NULL,
	`rating` integer DEFAULT 1500 NOT NULL,
	`comparisons` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cull_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_csp_session_id` ON `cull_session_photos` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_photo_id` ON `cull_session_photos` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_rating` ON `cull_session_photos` (`rating`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_csp_session_photo` ON `cull_session_photos` (`session_id`,`photo_id`);--> statement-breakpoint
CREATE TABLE `cull_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT 'duel' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`total_photos` integer DEFAULT 0 NOT NULL,
	`completed_comparisons` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
