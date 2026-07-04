-- 复合索引：覆盖"浏览所有照片"热查询 (listPhotos: WHERE deleted_at IS NULL ORDER BY file_date DESC)
CREATE INDEX IF NOT EXISTS idx_photos_deleted_file_date ON photos(deleted_at, file_date);
--> statement-breakpoint
-- 复合索引：覆盖"按文件夹浏览"热查询
CREATE INDEX IF NOT EXISTS idx_photos_deleted_folder_file_date ON photos(deleted_at, folder_id, file_date);
--> statement-breakpoint
-- 复合索引：覆盖"仅收藏浏览"热查询
CREATE INDEX IF NOT EXISTS idx_photos_deleted_fav_file_date ON photos(deleted_at, is_favorite, file_date);
--> statement-breakpoint
-- 单列索引：覆盖去重阶段1 fileSize 匹配 (checkNewPhotoDuplicates: WHERE file_size = ?)
CREATE INDEX IF NOT EXISTS idx_photos_file_size ON photos(file_size);
--> statement-breakpoint
-- 单列索引：覆盖缩略图反查 (findPhotoPathByThumbnail: WHERE thumbnail_path = ?)
CREATE INDEX IF NOT EXISTS idx_photos_thumbnail_path ON photos(thumbnail_path);
