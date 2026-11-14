DROP INDEX `idx_face_review_decision_photo_face`;--> statement-breakpoint
ALTER TABLE `face_review_decisions` ADD `content_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_face_review_decision_photo_face` ON `face_review_decisions` (`photo_id`,`face_index`,`content_revision`);