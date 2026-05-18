CREATE TABLE `album_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`album_id` integer,
	`photo_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_album_photo` ON `album_photos` (`album_id`,`photo_id`);--> statement-breakpoint
CREATE TABLE `albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cover_photo_id` integer,
	`is_smart` integer DEFAULT false NOT NULL,
	`smart_rules` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exif_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer,
	`camera_make` text,
	`camera_model` text,
	`lens_make` text,
	`lens_model` text,
	`focal_length` text,
	`focal_length_35mm` text,
	`aperture` real,
	`shutter_speed` text,
	`iso` integer,
	`exposure_compensation` real,
	`date_taken` integer,
	`date_digitized` integer,
	`flash` integer,
	`orientation` integer,
	`gps_latitude` real,
	`gps_longitude` real,
	`gps_altitude` real,
	`software` text,
	`image_description` text,
	`artist` text,
	`copyright` text,
	`raw_json` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exif_data_photo_id_unique` ON `exif_data` (`photo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_exif_date_taken` ON `exif_data` (`date_taken`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`display_name` text NOT NULL,
	`photo_count` integer DEFAULT 0 NOT NULL,
	`last_scanned_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_path_unique` ON `folders` (`path`);--> statement-breakpoint
CREATE TABLE `photo_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer,
	`tag_id` integer,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_photo_tag` ON `photo_tags` (`photo_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`folder_id` integer,
	`filename` text NOT NULL,
	`file_size` integer,
	`file_date` integer,
	`width` integer,
	`height` integer,
	`format` text,
	`color_space` text,
	`has_alpha` integer,
	`thumbnail_path` text,
	`thumbnail_size` text,
	`phash` text,
	`vector_id` text,
	`is_indexed` integer DEFAULT false NOT NULL,
	`is_ai_processed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_path_unique` ON `photos` (`path`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`color` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);