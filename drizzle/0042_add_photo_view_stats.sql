CREATE TABLE `photo_view_stats` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` integer,
	`wander_shown_count` integer DEFAULT 0 NOT NULL,
	`last_wandered_at` integer,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_view_stats_viewed` ON `photo_view_stats` (`view_count`,`last_viewed_at`);
--> statement-breakpoint
CREATE INDEX `idx_photo_view_stats_wandered` ON `photo_view_stats` (`wander_shown_count`,`last_wandered_at`);
