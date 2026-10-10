CREATE TABLE `search_data_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
INSERT INTO `search_data_revision` (`id`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER `search_revision_photos_insert` AFTER INSERT ON `photos`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_photos_delete` AFTER DELETE ON `photos`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_photos_update` AFTER UPDATE OF `id`, `filename`, `path`, `file_date`, `dominant_colors`, `color_bucket`, `deleted_at` ON `photos`
WHEN OLD.`id` IS NOT NEW.`id` OR OLD.`filename` IS NOT NEW.`filename` OR OLD.`path` IS NOT NEW.`path` OR OLD.`file_date` IS NOT NEW.`file_date` OR OLD.`dominant_colors` IS NOT NEW.`dominant_colors` OR OLD.`color_bucket` IS NOT NEW.`color_bucket` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_exif_data_insert` AFTER INSERT ON `exif_data`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_exif_data_delete` AFTER DELETE ON `exif_data`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_exif_data_update` AFTER UPDATE OF `photo_id`, `date_taken`, `camera_model`, `lens_model`, `focal_length_num`, `aperture`, `iso`, `shutter_speed_num`, `artist` ON `exif_data`
WHEN OLD.`photo_id` IS NOT NEW.`photo_id` OR OLD.`date_taken` IS NOT NEW.`date_taken` OR OLD.`camera_model` IS NOT NEW.`camera_model` OR OLD.`lens_model` IS NOT NEW.`lens_model` OR OLD.`focal_length_num` IS NOT NEW.`focal_length_num` OR OLD.`aperture` IS NOT NEW.`aperture` OR OLD.`iso` IS NOT NEW.`iso` OR OLD.`shutter_speed_num` IS NOT NEW.`shutter_speed_num` OR OLD.`artist` IS NOT NEW.`artist`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_advanced_exif_data_insert` AFTER INSERT ON `advanced_exif_data`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_advanced_exif_data_delete` AFTER DELETE ON `advanced_exif_data`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_advanced_exif_data_update` AFTER UPDATE OF `photo_id`, `vendor`, `capture_mode`, `exposure_program`, `metering_mode`, `white_balance`, `focus_mode`, `subject_target`, `drive_mode`, `stabilization_mode`, `computational_mode`, `in_camera_look`, `provenance_status`, `normalized_json` ON `advanced_exif_data`
WHEN OLD.`photo_id` IS NOT NEW.`photo_id` OR OLD.`vendor` IS NOT NEW.`vendor` OR OLD.`capture_mode` IS NOT NEW.`capture_mode` OR OLD.`exposure_program` IS NOT NEW.`exposure_program` OR OLD.`metering_mode` IS NOT NEW.`metering_mode` OR OLD.`white_balance` IS NOT NEW.`white_balance` OR OLD.`focus_mode` IS NOT NEW.`focus_mode` OR OLD.`subject_target` IS NOT NEW.`subject_target` OR OLD.`drive_mode` IS NOT NEW.`drive_mode` OR OLD.`stabilization_mode` IS NOT NEW.`stabilization_mode` OR OLD.`computational_mode` IS NOT NEW.`computational_mode` OR OLD.`in_camera_look` IS NOT NEW.`in_camera_look` OR OLD.`provenance_status` IS NOT NEW.`provenance_status` OR OLD.`normalized_json` IS NOT NEW.`normalized_json`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_tags_insert` AFTER INSERT ON `tags`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_tags_delete` AFTER DELETE ON `tags`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_tags_update` AFTER UPDATE OF `id`, `name` ON `tags`
WHEN OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_photo_tags_insert` AFTER INSERT ON `photo_tags`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_photo_tags_delete` AFTER DELETE ON `photo_tags`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_photo_tags_update` AFTER UPDATE OF `photo_id`, `tag_id`, `confidence`, `origin`, `user_confirmed` ON `photo_tags`
WHEN OLD.`photo_id` IS NOT NEW.`photo_id` OR OLD.`tag_id` IS NOT NEW.`tag_id` OR OLD.`confidence` IS NOT NEW.`confidence` OR OLD.`origin` IS NOT NEW.`origin` OR OLD.`user_confirmed` IS NOT NEW.`user_confirmed`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identities_insert` AFTER INSERT ON `face_identities`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identities_delete` AFTER DELETE ON `face_identities`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identities_update` AFTER UPDATE OF `id`, `name` ON `face_identities`
WHEN OLD.`id` IS NOT NEW.`id` OR OLD.`name` IS NOT NEW.`name`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_vectors_insert` AFTER INSERT ON `face_vectors`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_vectors_delete` AFTER DELETE ON `face_vectors`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_vectors_update` AFTER UPDATE OF `id`, `photo_id` ON `face_vectors`
WHEN OLD.`id` IS NOT NEW.`id` OR OLD.`photo_id` IS NOT NEW.`photo_id`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identity_members_insert` AFTER INSERT ON `face_identity_members`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identity_members_delete` AFTER DELETE ON `face_identity_members`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `search_revision_face_identity_members_update` AFTER UPDATE OF `identity_id`, `face_vector_id` ON `face_identity_members`
WHEN OLD.`identity_id` IS NOT NEW.`identity_id` OR OLD.`face_vector_id` IS NOT NEW.`face_vector_id`
BEGIN
  UPDATE `search_data_revision` SET `revision` = `revision` + 1 WHERE `id` = 1;
END;
