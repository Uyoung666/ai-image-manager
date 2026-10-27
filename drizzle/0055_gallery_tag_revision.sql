INSERT INTO gallery_data_revision (id, revision) VALUES (3, 0);
--> statement-breakpoint
DROP TRIGGER gallery_revision_photo_tags_insert;
--> statement-breakpoint
DROP TRIGGER gallery_revision_photo_tags_delete;
--> statement-breakpoint
DROP TRIGGER gallery_revision_photo_tags_update;
--> statement-breakpoint
DROP TRIGGER gallery_revision_tags_insert;
--> statement-breakpoint
DROP TRIGGER gallery_revision_tags_delete;
--> statement-breakpoint
DROP TRIGGER gallery_revision_tags_update;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_insert AFTER INSERT ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_delete AFTER DELETE ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_photo_tags_update AFTER UPDATE OF photo_id,tag_id,origin,user_confirmed ON photo_tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_insert AFTER INSERT ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_delete AFTER DELETE ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
--> statement-breakpoint
CREATE TRIGGER gallery_revision_tags_update AFTER UPDATE OF parent_id,name ON tags BEGIN UPDATE gallery_data_revision SET revision=revision+1 WHERE id=3; END;
