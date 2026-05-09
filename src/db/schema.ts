import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  displayName: text("display_name").notNull(),
  photoCount: integer("photo_count").notNull().default(0),
  lastScannedAt: integer("last_scanned_at"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  folderId: integer("folder_id").references(() => folders.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  fileSize: integer("file_size"),
  fileDate: integer("file_date"),
  width: integer("width"),
  height: integer("height"),
  format: text("format"),
  colorSpace: text("color_space"),
  hasAlpha: integer("has_alpha", { mode: "boolean" }),
  thumbnailPath: text("thumbnail_path"),
  thumbnailSize: text("thumbnail_size"),
  phash: text("phash"),
  vectorId: text("vector_id"),
  isIndexed: integer("is_indexed", { mode: "boolean" }).notNull().default(false),
  isAiProcessed: integer("is_ai_processed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const exifData = sqliteTable("exif_data", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  photoId: integer("photo_id").references(() => photos.id, { onDelete: "cascade" }).unique(),
  cameraMake: text("camera_make"),
  cameraModel: text("camera_model"),
  lensMake: text("lens_make"),
  lensModel: text("lens_model"),
  focalLength: text("focal_length"),
  focalLength35mm: text("focal_length_35mm"),
  aperture: real("aperture"),
  shutterSpeed: text("shutter_speed"),
  iso: integer("iso"),
  exposureCompensation: real("exposure_compensation"),
  dateTaken: integer("date_taken"),
  dateDigitized: integer("date_digitized"),
  flash: integer("flash", { mode: "boolean" }),
  orientation: integer("orientation"),
  gpsLatitude: real("gps_latitude"),
  gpsLongitude: real("gps_longitude"),
  gpsAltitude: real("gps_altitude"),
  software: text("software"),
  imageDescription: text("image_description"),
  artist: text("artist"),
  copyright: text("copyright"),
  rawJson: text("raw_json"),
}, (table) => ({
  dateTakenIdx: uniqueIndex("idx_exif_date_taken").on(table.dateTaken),
}));

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  parentId: integer("parent_id"),
  color: text("color"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const photoTags = sqliteTable("photo_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  photoId: integer("photo_id").references(() => photos.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").references(() => tags.id, { onDelete: "cascade" }),
}, (table) => ({
  uniquePhotoTag: uniqueIndex("idx_photo_tag").on(table.photoId, table.tagId),
}));

export const albums = sqliteTable("albums", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  coverPhotoId: integer("cover_photo_id"),
  isSmart: integer("is_smart", { mode: "boolean" }).notNull().default(false),
  smartRules: text("smart_rules"),
  createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const albumPhotos = sqliteTable("album_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  albumId: integer("album_id").references(() => albums.id, { onDelete: "cascade" }),
  photoId: integer("photo_id").references(() => photos.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => ({
  uniqueAlbumPhoto: uniqueIndex("idx_album_photo").on(table.albumId, table.photoId),
}));

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
});
