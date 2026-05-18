ALTER TABLE `photos` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_at` ON `photos` (`deleted_at`);