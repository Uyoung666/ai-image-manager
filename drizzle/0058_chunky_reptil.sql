PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cull_session_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`photo_id` integer,
	`project_photo_id` text,
	`rating` integer DEFAULT 1500 NOT NULL,
	`comparisons` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cull_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_photo_id`) REFERENCES `shooting_project_photos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "csp_exactly_one_source" CHECK(("__new_cull_session_photos"."photo_id" IS NOT NULL AND "__new_cull_session_photos"."project_photo_id" IS NULL) OR ("__new_cull_session_photos"."photo_id" IS NULL AND "__new_cull_session_photos"."project_photo_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_cull_session_photos`("id", "session_id", "photo_id", "project_photo_id", "rating", "comparisons", "wins", "losses", "status") SELECT "id", "session_id", "photo_id", NULL, "rating", "comparisons", "wins", "losses", "status" FROM `cull_session_photos`;--> statement-breakpoint
DROP TABLE `cull_session_photos`;--> statement-breakpoint
ALTER TABLE `__new_cull_session_photos` RENAME TO `cull_session_photos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_csp_session_id` ON `cull_session_photos` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_photo_id` ON `cull_session_photos` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_project_photo_id` ON `cull_session_photos` (`project_photo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_csp_session_project_photo` ON `cull_session_photos` (`session_id`,`project_photo_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_rating` ON `cull_session_photos` (`rating`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_csp_session_photo` ON `cull_session_photos` (`session_id`,`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_csp_session_status` ON `cull_session_photos` (`session_id`,`status`);--> statement-breakpoint
ALTER TABLE `cull_sessions` ADD `project_id` text REFERENCES shooting_projects(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `cull_sessions` ADD `project_scope` text;--> statement-breakpoint
ALTER TABLE `cull_sessions` ADD `project_scope_open` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `phash` text;--> statement-breakpoint
ALTER TABLE `shooting_project_photos` ADD `exif_json` text;