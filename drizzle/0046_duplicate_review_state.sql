CREATE TABLE `duplicate_review_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_key` text NOT NULL,
	`group_version` text NOT NULL,
	`review_revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`photo_id` integer,
	`decision` text,
	`content_revision` integer,
	`details_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_event_group` ON `duplicate_review_events` (`group_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_event_photo` ON `duplicate_review_events` (`photo_id`);--> statement-breakpoint
CREATE TABLE `duplicate_review_groups` (
	`group_key` text PRIMARY KEY NOT NULL,
	`group_version` text NOT NULL,
	`review_revision` integer DEFAULT 0 NOT NULL,
	`ignore_state` text DEFAULT 'ACTIVE' NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`needs_review` integer DEFAULT true NOT NULL,
	`member_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_group_version` ON `duplicate_review_groups` (`group_version`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_group_needs_review` ON `duplicate_review_groups` (`needs_review`);--> statement-breakpoint
CREATE TABLE `duplicate_review_members` (
	`group_key` text NOT NULL,
	`photo_id` integer NOT NULL,
	`decision` text DEFAULT 'UNDECIDED' NOT NULL,
	`content_revision` integer DEFAULT 0 NOT NULL,
	`needs_review` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`group_key`, `photo_id`),
	FOREIGN KEY (`group_key`) REFERENCES `duplicate_review_groups`(`group_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_member_photo_id` ON `duplicate_review_members` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_duplicate_review_member_decision` ON `duplicate_review_members` (`decision`);