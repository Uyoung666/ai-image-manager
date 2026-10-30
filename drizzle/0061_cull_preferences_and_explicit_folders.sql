ALTER TABLE `folders` ADD `explicit_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shooting_projects` ADD `pk_mode` text DEFAULT 'standard' NOT NULL;