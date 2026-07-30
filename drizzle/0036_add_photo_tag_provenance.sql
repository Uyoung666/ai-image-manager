ALTER TABLE `photo_tags` ADD `origin` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `photo_tags` ADD `user_confirmed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `photo_tags`
SET
  `origin` = CASE
    WHEN `confidence` IS NULL THEN 'manual'
    ELSE 'auto'
  END,
  `user_confirmed` = CASE
    WHEN `confidence` IS NULL THEN 1
    ELSE 0
  END;
