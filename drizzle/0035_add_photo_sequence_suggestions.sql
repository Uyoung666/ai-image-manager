CREATE TABLE `photo_sequence_suggestions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `first_sequence_id` integer NOT NULL,
  `second_sequence_id` integer NOT NULL,
  `confidence` real NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`first_sequence_id`) REFERENCES `photo_sequences`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`second_sequence_id`) REFERENCES `photo_sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sequence_suggestion_pair` ON `photo_sequence_suggestions` (`first_sequence_id`,`second_sequence_id`);
--> statement-breakpoint
CREATE INDEX `idx_sequence_suggestion_status` ON `photo_sequence_suggestions` (`status`);
