CREATE TABLE `plugin_installations` (
	`plugin_id` text NOT NULL,
	`version` text NOT NULL,
	`origin` text NOT NULL,
	`relative_location` text,
	`source_location` text,
	`checksum` text,
	`manifest_json` text NOT NULL,
	`installed_at` integer NOT NULL,
	`status` text DEFAULT 'installed' NOT NULL,
	`last_error_code` text,
	`last_error_detail` text,
	PRIMARY KEY(`plugin_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `plugin_preferences` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`selected_version` text,
	`last_known_good_version` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`settings_schema_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plugin_assets` (
	`plugin_id` text NOT NULL,
	`setting_id` text NOT NULL,
	`managed_path` text NOT NULL,
	`revision` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`plugin_id`,`setting_id`)
);
