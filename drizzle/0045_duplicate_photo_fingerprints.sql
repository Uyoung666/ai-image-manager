CREATE TABLE `duplicate_photo_fingerprints` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`file_size` integer NOT NULL,
	`modified_at` real NOT NULL,
	`content_revision` integer DEFAULT 1 NOT NULL,
	`sample_hash` text,
	`full_sha256` text,
	`hash_version` text NOT NULL,
	`verified_at` integer,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_fingerprint_hash` ON `duplicate_photo_fingerprints` (`hash_version`,`full_sha256`);
--> statement-breakpoint
CREATE INDEX `idx_duplicate_fingerprint_path` ON `duplicate_photo_fingerprints` (`path`);
