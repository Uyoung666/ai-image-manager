CREATE TABLE `advanced_exif_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`parser_version` integer DEFAULT 1 NOT NULL,
	`enriched_at` integer,
	`error_message` text,
	`vendor` text,
	`capture_mode` text,
	`exposure_program` text,
	`metering_mode` text,
	`white_balance` text,
	`focus_mode` text,
	`focus_area` text,
	`subject_target` text,
	`eye_detection` integer,
	`tracking` integer,
	`drive_mode` text,
	`stabilization_mode` text,
	`computational_mode` text,
	`in_camera_look` text,
	`provenance_status` text DEFAULT 'unknown' NOT NULL,
	`provenance_issuer` text,
	`normalized_json` text,
	`vendor_raw_json` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advanced_exif_data_photo_id_unique` ON `advanced_exif_data` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_status_version` ON `advanced_exif_data` (`status`,`parser_version`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_vendor` ON `advanced_exif_data` (`vendor`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_capture_mode` ON `advanced_exif_data` (`capture_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_exposure_program` ON `advanced_exif_data` (`exposure_program`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_metering_mode` ON `advanced_exif_data` (`metering_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_white_balance` ON `advanced_exif_data` (`white_balance`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_focus_mode` ON `advanced_exif_data` (`focus_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_subject_target` ON `advanced_exif_data` (`subject_target`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_drive_mode` ON `advanced_exif_data` (`drive_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_stabilization` ON `advanced_exif_data` (`stabilization_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_computational` ON `advanced_exif_data` (`computational_mode`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_in_camera_look` ON `advanced_exif_data` (`in_camera_look`);--> statement-breakpoint
CREATE INDEX `idx_advanced_exif_provenance` ON `advanced_exif_data` (`provenance_status`);