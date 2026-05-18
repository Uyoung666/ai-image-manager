ALTER TABLE `photo_tags` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `photo_tags` ADD `is_confirmed` integer DEFAULT false NOT NULL;