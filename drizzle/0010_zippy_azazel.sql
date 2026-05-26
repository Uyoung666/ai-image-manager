ALTER TABLE `folders` ADD `is_watching` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `folders` ADD `watcher_started_at` integer;--> statement-breakpoint
ALTER TABLE `folders` ADD `last_watcher_event_at` integer;