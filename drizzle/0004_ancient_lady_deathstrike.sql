ALTER TABLE `face_identities` ADD `centroid_embedding` text;--> statement-breakpoint
ALTER TABLE `face_vectors` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `face_vectors` ADD `embedding` text;