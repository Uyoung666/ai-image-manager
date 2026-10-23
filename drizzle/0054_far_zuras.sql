CREATE TABLE `gallery_data_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_name` ON `photos` (`deleted_at`,`filename`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_size` ON `photos` (`deleted_at`,`file_size`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_folder_name` ON `photos` (`deleted_at`,`folder_id`,`filename`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_folder_size` ON `photos` (`deleted_at`,`folder_id`,`file_size`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_fav_name` ON `photos` (`deleted_at`,`is_favorite`,`filename`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_fav_size` ON `photos` (`deleted_at`,`is_favorite`,`file_size`,`id`);
--> statement-breakpoint
INSERT INTO gallery_data_revision (id,revision) VALUES (1,0),(2,0);
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photos_insert AFTER INSERT ON photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photos_delete AFTER DELETE ON photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_insert AFTER INSERT ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_delete AFTER DELETE ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_insert AFTER INSERT ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_delete AFTER DELETE ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_folders_insert AFTER INSERT ON folders BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_folders_delete AFTER DELETE ON folders BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_album_photos_insert AFTER INSERT ON album_photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_album_photos_delete AFTER DELETE ON album_photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_sequence_members_insert AFTER INSERT ON photo_sequence_members BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_sequence_members_delete AFTER DELETE ON photo_sequence_members BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photos_update AFTER UPDATE OF filename,path,file_date,file_size,folder_id,deleted_at,width,height ON photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_update AFTER UPDATE OF photo_id,tag_id,origin,user_confirmed ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_update AFTER UPDATE OF parent_id,name ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_folders_update AFTER UPDATE OF parent_id ON folders BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_album_photos_update AFTER UPDATE OF album_id,photo_id,sort_order ON album_photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_sequence_members_update AFTER UPDATE OF photo_id,sequence_id,position ON photo_sequence_members BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_albums_update AFTER UPDATE OF smart_rules,is_smart ON albums BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id IN (1,2); END;

--> statement-breakpoint
CREATE TRIGGER gallery_revision_favorites_update AFTER UPDATE OF is_favorite ON photos BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=1; END;
