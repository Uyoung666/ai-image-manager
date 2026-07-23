import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const folders = sqliteTable(
  "folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").notNull().unique(),
    displayName: text("display_name").notNull(),
    appearanceColor: text("appearance_color"),
    appearanceIcon: text("appearance_icon"),
    parentId: integer("parent_id"),
    photoCount: integer("photo_count").notNull().default(0),
    lastScannedAt: integer("last_scanned_at"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    isWatching: integer("is_watching", { mode: "boolean" })
      .notNull()
      .default(false),
    watcherStartedAt: integer("watcher_started_at"),
    lastWatcherEventAt: integer("last_watcher_event_at"),
  },
  (table) => ({
    parentIdIdx: index("idx_folders_parent_id").on(table.parentId),
  })
);

export const photos = sqliteTable(
  "photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").notNull().unique(),
    folderId: integer("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
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
    duelPreviewPath: text("duel_preview_path"),
    dominantColors: text("dominant_colors"),
    colorBucket: integer("color_bucket"),
    phash: text("phash"),
    contentHash: text("content_hash"),
    vectorId: text("vector_id"),
    isIndexed: integer("is_indexed", { mode: "boolean" })
      .notNull()
      .default(false),
    isAiProcessed: integer("is_ai_processed", { mode: "boolean" })
      .notNull()
      .default(false),
    isFaceProcessed: integer("is_face_processed", { mode: "boolean" })
      .notNull()
      .default(false),
    isFavorite: integer("is_favorite", { mode: "boolean" })
      .notNull()
      .default(false),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    folderIdIdx: index("idx_photos_folder_id").on(table.folderId),
    isAiProcessedIdx: index("idx_photos_is_ai_processed").on(
      table.isAiProcessed
    ),
    isFaceProcessedIdx: index("idx_photos_is_face_processed").on(
      table.isFaceProcessed
    ),
    fileDateIdx: index("idx_photos_file_date").on(table.fileDate),
    phashIdx: index("idx_photos_phash").on(table.phash),
    deletedAtIdx: index("idx_photos_deleted_at").on(table.deletedAt),
    deletedFileDateIdx: index("idx_photos_deleted_file_date").on(
      table.deletedAt,
      table.fileDate
    ),
    deletedFolderFileDateIdx: index("idx_photos_deleted_folder_file_date").on(
      table.deletedAt,
      table.folderId,
      table.fileDate
    ),
    deletedFavFileDateIdx: index("idx_photos_deleted_fav_file_date").on(
      table.deletedAt,
      table.isFavorite,
      table.fileDate
    ),
    fileSizeIdx: index("idx_photos_file_size").on(table.fileSize),
    thumbnailPathIdx: index("idx_photos_thumbnail_path").on(
      table.thumbnailPath
    ),
    filenameIdx: index("idx_photos_filename").on(table.filename),
    colorBucketIdx: index("idx_photos_color_bucket").on(table.colorBucket),
  })
);

export const exifData = sqliteTable(
  "exif_data",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoId: integer("photo_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .unique(),
    cameraMake: text("camera_make"),
    cameraModel: text("camera_model"),
    lensMake: text("lens_make"),
    lensModel: text("lens_model"),
    focalLength: text("focal_length"),
    focalLength35mm: text("focal_length_35mm"),
    focalLengthNum: real("focal_length_num"),
    aperture: real("aperture"),
    shutterSpeed: text("shutter_speed"),
    shutterSpeedNum: real("shutter_speed_num"),
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
  },
  (table) => ({
    dateTakenIdx: index("idx_exif_date_taken").on(table.dateTaken),
    cameraModelIdx: index("idx_exif_camera_model").on(table.cameraModel),
    lensModelIdx: index("idx_exif_lens_model").on(table.lensModel),
    focalLengthIdx: index("idx_exif_focal_length").on(table.focalLength),
    apertureIdx: index("idx_exif_aperture").on(table.aperture),
    isoIdx: index("idx_exif_iso").on(table.iso),
    shutterSpeedIdx: index("idx_exif_shutter_speed").on(table.shutterSpeed),
    focalLengthNumIdx: index("idx_exif_focal_length_num").on(
      table.focalLengthNum
    ),
    shutterSpeedNumIdx: index("idx_exif_shutter_speed_num").on(
      table.shutterSpeedNum
    ),
    cameraDateIdx: index("idx_exif_camera_date").on(
      table.cameraModel,
      table.dateTaken
    ),
    isoApertureIdx: index("idx_exif_iso_aperture").on(
      table.iso,
      table.aperture
    ),
    focalApertureIdx: index("idx_exif_focal_aperture").on(
      table.focalLengthNum,
      table.aperture
    ),
    shutterIsoIdx: index("idx_exif_shutter_iso").on(
      table.shutterSpeedNum,
      table.iso
    ),
  })
);

export const advancedExifData = sqliteTable(
  "advanced_exif_data",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoId: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" })
      .unique(),
    status: text("status").notNull().default("pending"),
    parserVersion: integer("parser_version").notNull().default(1),
    enrichedAt: integer("enriched_at"),
    errorMessage: text("error_message"),
    vendor: text("vendor"),
    captureMode: text("capture_mode"),
    exposureProgram: text("exposure_program"),
    meteringMode: text("metering_mode"),
    whiteBalance: text("white_balance"),
    focusMode: text("focus_mode"),
    focusArea: text("focus_area"),
    subjectTarget: text("subject_target"),
    eyeDetection: integer("eye_detection", { mode: "boolean" }),
    tracking: integer("tracking", { mode: "boolean" }),
    driveMode: text("drive_mode"),
    stabilizationMode: text("stabilization_mode"),
    computationalMode: text("computational_mode"),
    inCameraLook: text("in_camera_look"),
    provenanceStatus: text("provenance_status").notNull().default("unknown"),
    provenanceIssuer: text("provenance_issuer"),
    normalizedJson: text("normalized_json"),
    vendorRawJson: text("vendor_raw_json"),
  },
  (table) => ({
    statusVersionIdx: index("idx_advanced_exif_status_version").on(
      table.status,
      table.parserVersion
    ),
    vendorIdx: index("idx_advanced_exif_vendor").on(table.vendor),
    captureModeIdx: index("idx_advanced_exif_capture_mode").on(
      table.captureMode
    ),
    exposureProgramIdx: index("idx_advanced_exif_exposure_program").on(
      table.exposureProgram
    ),
    meteringModeIdx: index("idx_advanced_exif_metering_mode").on(
      table.meteringMode
    ),
    whiteBalanceIdx: index("idx_advanced_exif_white_balance").on(
      table.whiteBalance
    ),
    focusModeIdx: index("idx_advanced_exif_focus_mode").on(table.focusMode),
    subjectTargetIdx: index("idx_advanced_exif_subject_target").on(
      table.subjectTarget
    ),
    driveModeIdx: index("idx_advanced_exif_drive_mode").on(table.driveMode),
    stabilizationIdx: index("idx_advanced_exif_stabilization").on(
      table.stabilizationMode
    ),
    computationalIdx: index("idx_advanced_exif_computational").on(
      table.computationalMode
    ),
    inCameraLookIdx: index("idx_advanced_exif_in_camera_look").on(
      table.inCameraLook
    ),
    provenanceIdx: index("idx_advanced_exif_provenance").on(
      table.provenanceStatus
    ),
  })
);

/** A visually related run of photos, detected from EXIF and capture time. */
export const photoSequences = sqliteTable(
  "photo_sequences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    folderId: integer("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(), // burst | timelapse
    source: text("source").notNull().default("auto"), // auto | manual
    representativePhotoId: integer("representative_photo_id").references(
      () => photos.id,
      { onDelete: "set null" }
    ),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at").notNull(),
    frameCount: integer("frame_count").notNull(),
    userLocked: integer("user_locked", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    folderTimeIdx: index("idx_sequence_folder_time").on(
      table.folderId,
      table.startedAt
    ),
    representativeIdx: index("idx_sequence_representative").on(
      table.representativePhotoId
    ),
  })
);

export const photoSequenceMembers = sqliteTable(
  "photo_sequence_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sequenceId: integer("sequence_id")
      .notNull()
      .references(() => photoSequences.id, { onDelete: "cascade" }),
    photoId: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => ({
    sequencePositionIdx: uniqueIndex("idx_sequence_member_position").on(
      table.sequenceId,
      table.position
    ),
    photoIdx: uniqueIndex("idx_sequence_member_photo").on(table.photoId),
  })
);

/** Permanent exclusions for photos a user explicitly removed from auto grouping. */
export const photoSequenceExclusions = sqliteTable(
  "photo_sequence_exclusions",
  {
    photoId: integer("photo_id")
      .primaryKey()
      .references(() => photos.id, { onDelete: "cascade" }),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  }
);

/** A conservative, user-confirmed bridge between two automatically detected runs. */
export const photoSequenceSuggestions = sqliteTable(
  "photo_sequence_suggestions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    firstSequenceId: integer("first_sequence_id")
      .notNull()
      .references(() => photoSequences.id, { onDelete: "cascade" }),
    secondSequenceId: integer("second_sequence_id")
      .notNull()
      .references(() => photoSequences.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | dismissed
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    pairIdx: uniqueIndex("idx_sequence_suggestion_pair").on(
      table.firstSequenceId,
      table.secondSequenceId
    ),
    statusIdx: index("idx_sequence_suggestion_status").on(table.status),
  })
);

export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    parentId: integer("parent_id").references((): any => tags.id, {
      onDelete: "set null",
    }),
    color: text("color"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    parentIdIdx: index("idx_tags_parent_id").on(table.parentId),
  })
);

export const photoTags = sqliteTable(
  "photo_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoId: integer("photo_id").references(() => photos.id, {
      onDelete: "cascade",
    }),
    tagId: integer("tag_id").references(() => tags.id, { onDelete: "cascade" }),
    confidence: real("confidence"),
    isConfirmed: integer("is_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => ({
    uniquePhotoTag: uniqueIndex("idx_photo_tag").on(table.photoId, table.tagId),
    photoIdIdx: index("idx_pt_photo_id").on(table.photoId),
    tagIdIdx: index("idx_pt_tag_id").on(table.tagId),
  })
);

export const albums = sqliteTable("albums", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  coverPhotoId: integer("cover_photo_id"),
  isSmart: integer("is_smart", { mode: "boolean" }).notNull().default(false),
  smartRules: text("smart_rules"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const albumPhotos = sqliteTable(
  "album_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    albumId: integer("album_id").references(() => albums.id, {
      onDelete: "cascade",
    }),
    photoId: integer("photo_id").references(() => photos.id, {
      onDelete: "cascade",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    uniqueAlbumPhoto: uniqueIndex("idx_album_photo").on(
      table.albumId,
      table.photoId
    ),
  })
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const faceVectors = sqliteTable(
  "face_vectors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoId: integer("photo_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    faceIndex: integer("face_index").notNull().default(0),
    bboxX: real("bbox_x").notNull(),
    bboxY: real("bbox_y").notNull(),
    bboxWidth: real("bbox_width").notNull(),
    bboxHeight: real("bbox_height").notNull(),
    confidence: real("confidence"),
    embedding: text("embedding"),
    vectorId: text("vector_id"),
    isRejected: integer("is_rejected", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    photoIdIdx: index("idx_face_vectors_photo_id").on(table.photoId),
  })
);

export const faceIdentities = sqliteTable(
  "face_identities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name"),
    representativePhotoId: integer("representative_photo_id").references(
      () => photos.id,
      { onDelete: "set null" }
    ),
    representativeVectorId: text("representative_vector_id"),
    centroidEmbedding: text("centroid_embedding"),
    faceCount: integer("face_count").notNull().default(0),
    isConfirmed: integer("is_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    repPhotoIdIdx: index("idx_face_identities_rep_photo").on(
      table.representativePhotoId
    ),
    nameIdx: index("idx_face_identities_name").on(table.name),
  })
);

export const faceIdentityMembers = sqliteTable(
  "face_identity_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: integer("identity_id")
      .references(() => faceIdentities.id, { onDelete: "cascade" })
      .notNull(),
    faceVectorId: integer("face_vector_id")
      .references(() => faceVectors.id, { onDelete: "cascade" })
      .notNull(),
  },
  (table) => ({
    uniqueFaceIdMember: uniqueIndex("idx_face_id_member").on(
      table.identityId,
      table.faceVectorId
    ),
    faceVectorIdIdx: index("idx_face_id_member_fv_id").on(table.faceVectorId),
  })
);

export const duplicatePairs = sqliteTable(
  "duplicate_pairs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoAId: integer("photo_a_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    photoBId: integer("photo_b_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    matchType: text("match_type").notNull(), // 'exact' | 'phash' | 'clip_confirmed'
    phashDistance: integer("phash_distance"),
    clipSimilarity: real("clip_similarity"),
    status: text("status").notNull().default("pending"), // 'pending' | 'confirmed' | 'dismissed'
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    resolvedAt: integer("resolved_at"),
  },
  (table) => ({
    uniquePair: uniqueIndex("idx_dup_pair").on(table.photoAId, table.photoBId),
    statusIdx: index("idx_dup_status").on(table.status),
    photoAIdx: index("idx_dup_photo_a").on(table.photoAId),
    photoBIdx: index("idx_dup_photo_b").on(table.photoBId),
  })
);

export const detectionRuns = sqliteTable("detection_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lastPhotoId: integer("last_photo_id").notNull(),
  photosProcessed: integer("photos_processed").notNull().default(0),
  pairsFound: integer("pairs_found").notNull().default(0),
  completedAt: integer("completed_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const cloudConfigs = sqliteTable("cloud_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const cullSessions = sqliteTable("cull_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("duel"),
  status: text("status").notNull().default("active"),
  totalPhotos: integer("total_photos").notNull().default(0),
  completedComparisons: integer("completed_comparisons").notNull().default(0),
  pkMode: text("pk_mode").notNull().default("standard"),
  sortStrategy: text("sort_strategy").notNull().default("time"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
  completedAt: integer("completed_at"),
});

export const cullSessionPhotos = sqliteTable(
  "cull_session_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .references(() => cullSessions.id, { onDelete: "cascade" })
      .notNull(),
    photoId: integer("photo_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    rating: integer("rating").notNull().default(1500),
    comparisons: integer("comparisons").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    status: text("status").notNull().default("pending"),
  },
  (table) => ({
    sessionIdIdx: index("idx_csp_session_id").on(table.sessionId),
    photoIdIdx: index("idx_csp_photo_id").on(table.photoId),
    ratingIdx: index("idx_csp_rating").on(table.rating),
    uniqueSessionPhoto: uniqueIndex("idx_csp_session_photo").on(
      table.sessionId,
      table.photoId
    ),
    sessionStatusIdx: index("idx_csp_session_status").on(
      table.sessionId,
      table.status
    ),
  })
);

export const cullActionLogs = sqliteTable(
  "cull_action_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .references(() => cullSessions.id, { onDelete: "cascade" })
      .notNull(),
    action: text("action").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    sessionCreatedIdx: index("idx_cal_session_created").on(
      table.sessionId,
      table.createdAt
    ),
  })
);

export const cloudSyncLog = sqliteTable("cloud_sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  photoId: integer("photo_id").references(() => photos.id, {
    onDelete: "set null",
  }),
  providerId: integer("provider_id").references(() => cloudConfigs.id, {
    onDelete: "cascade",
  }),
  action: text("action").notNull(),
  status: text("status").notNull(),
  remotePath: text("remote_path"),
  error: text("error"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});
