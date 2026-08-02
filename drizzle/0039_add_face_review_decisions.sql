CREATE TABLE `face_review_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`face_index` integer NOT NULL,
	`decision` text NOT NULL,
	`source_identity_id` integer,
	`source_identity_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_identity_id`) REFERENCES `face_identities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_face_review_decision_photo_face` ON `face_review_decisions` (`photo_id`,`face_index`);
--> statement-breakpoint
CREATE INDEX `idx_face_review_decision_photo_id` ON `face_review_decisions` (`photo_id`);
--> statement-breakpoint
CREATE INDEX `idx_face_review_decision_source_identity` ON `face_review_decisions` (`source_identity_id`);
--> statement-breakpoint
INSERT INTO `face_review_decisions` (`photo_id`, `face_index`, `decision`, `source_identity_id`, `source_identity_name`, `created_at`, `updated_at`)
SELECT fv.photo_id, fv.face_index, 'removed_from_identity', fie.identity_id, fi.name,
       COALESCE(fie.created_at, strftime('%s','now') * 1000),
       COALESCE(fie.created_at, strftime('%s','now') * 1000)
FROM `face_identity_exclusions` fie
JOIN `face_vectors` fv ON fv.id = fie.face_vector_id
LEFT JOIN `face_identities` fi ON fi.id = fie.identity_id
WHERE NOT EXISTS (
  SELECT 1 FROM `face_review_decisions` frd
  WHERE frd.photo_id = fv.photo_id AND frd.face_index = fv.face_index
);
