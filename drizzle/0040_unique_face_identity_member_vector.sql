DELETE FROM `face_identity_members`
WHERE `id` NOT IN (
  SELECT MIN(`id`)
  FROM `face_identity_members`
  GROUP BY `face_vector_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_face_id_member_unique_vector` ON `face_identity_members` (`face_vector_id`);
