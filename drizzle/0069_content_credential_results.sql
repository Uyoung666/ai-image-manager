CREATE TABLE `content_credential_results` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`source_stamp` text NOT NULL,
	`result` text NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
