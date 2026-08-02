CREATE TABLE `face_identity_exclusions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_id` integer NOT NULL,
	`face_vector_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `face_identities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`face_vector_id`) REFERENCES `face_vectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_face_identity_exclusion` ON `face_identity_exclusions` (`identity_id`,`face_vector_id`);
--> statement-breakpoint
CREATE INDEX `idx_face_identity_exclusion_identity` ON `face_identity_exclusions` (`identity_id`);
--> statement-breakpoint
CREATE INDEX `idx_face_identity_exclusion_vector` ON `face_identity_exclusions` (`face_vector_id`);
