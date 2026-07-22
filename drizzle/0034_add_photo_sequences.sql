CREATE TABLE `photo_sequences` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `folder_id` integer,
  `type` text NOT NULL,
  `source` text DEFAULT 'auto' NOT NULL,
  `representative_photo_id` integer,
  `started_at` integer NOT NULL,
  `ended_at` integer NOT NULL,
  `frame_count` integer NOT NULL,
  `user_locked` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`representative_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sequence_folder_time` ON `photo_sequences` (`folder_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_sequence_representative` ON `photo_sequences` (`representative_photo_id`);
--> statement-breakpoint
CREATE TABLE `photo_sequence_members` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sequence_id` integer NOT NULL,
  `photo_id` integer NOT NULL,
  `position` integer NOT NULL,
  FOREIGN KEY (`sequence_id`) REFERENCES `photo_sequences`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sequence_member_position` ON `photo_sequence_members` (`sequence_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sequence_member_photo` ON `photo_sequence_members` (`photo_id`);
--> statement-breakpoint
CREATE TABLE `photo_sequence_exclusions` (
  `photo_id` integer PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
