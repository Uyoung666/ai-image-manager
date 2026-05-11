CREATE TABLE `cloud_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer,
	`provider_id` integer,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`remote_path` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `cloud_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `face_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`representative_photo_id` integer,
	`representative_vector_id` text,
	`face_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`representative_photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `face_identity_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity_id` integer NOT NULL,
	`face_vector_id` integer NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `face_identities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`face_vector_id`) REFERENCES `face_vectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_face_id_member` ON `face_identity_members` (`identity_id`,`face_vector_id`);--> statement-breakpoint
CREATE TABLE `face_vectors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`face_index` integer DEFAULT 0 NOT NULL,
	`bbox_x` real NOT NULL,
	`bbox_y` real NOT NULL,
	`bbox_width` real NOT NULL,
	`bbox_height` real NOT NULL,
	`vector_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
