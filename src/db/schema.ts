import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  index,
  integer,
  primaryKey,
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
    faceProcessingError: text("face_processing_error"),
    isFavorite: integer("is_favorite", { mode: "boolean" })
      .notNull()
      .default(false),
    deletedAt: integer("deleted_at"),
    deletionBatchId: text("deletion_batch_id"),
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

/** Lightweight engagement signals used to keep ambient photo discovery fresh. */
export const photoViewStats = sqliteTable(
  "photo_view_stats",
  {
    photoId: integer("photo_id")
      .primaryKey()
      .references(() => photos.id, { onDelete: "cascade" }),
    viewCount: integer("view_count").notNull().default(0),
    lastViewedAt: integer("last_viewed_at"),
    wanderShownCount: integer("wander_shown_count").notNull().default(0),
    lastWanderedAt: integer("last_wandered_at"),
  },
  (table) => ({
    viewedIdx: index("idx_photo_view_stats_viewed").on(
      table.viewCount,
      table.lastViewedAt
    ),
    wanderedIdx: index("idx_photo_view_stats_wandered").on(
      table.wanderShownCount,
      table.lastWanderedAt
    ),
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
    parentId: integer("parent_id").references((): AnySQLiteColumn => tags.id, {
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
    origin: text("origin", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    isConfirmed: integer("is_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    userConfirmed: integer("user_confirmed", { mode: "boolean" })
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

/** Installed plugin package metadata, keyed by plugin id and version. */
export const pluginInstallations = sqliteTable(
  "plugin_installations",
  {
    pluginId: text("plugin_id").notNull(),
    version: text("version").notNull(),
    origin: text("origin").notNull(),
    relativeLocation: text("relative_location"),
    sourceLocation: text("source_location"),
    checksum: text("checksum"),
    manifestJson: text("manifest_json").notNull(),
    installedAt: integer("installed_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    status: text("status").notNull().default("installed"),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
  },
  (table) => ({
    pluginInstallationsPk: primaryKey({
      columns: [table.pluginId, table.version],
      name: "plugin_installations_plugin_id_version_pk",
    }),
  })
);

/** User-selected plugin version and settings, intentionally independent from installations. */
export const pluginPreferences = sqliteTable("plugin_preferences", {
  pluginId: text("plugin_id").primaryKey(),
  selectedVersion: text("selected_version"),
  lastKnownGoodVersion: text("last_known_good_version"),
  settingsJson: text("settings_json").notNull().default("{}"),
  settingsSchemaVersion: integer("settings_schema_version")
    .notNull()
    .default(1),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

/** User-managed plugin assets, retained independently when an installation is removed. */
export const pluginAssets = sqliteTable(
  "plugin_assets",
  {
    pluginId: text("plugin_id").notNull(),
    settingId: text("setting_id").notNull(),
    managedPath: text("managed_path").notNull(),
    revision: text("revision").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    pluginAssetsPk: primaryKey({
      columns: [table.pluginId, table.settingId],
      name: "plugin_assets_plugin_id_setting_id_pk",
    }),
  })
);

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
    isHidden: integer("is_hidden", { mode: "boolean" })
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
    uniqueFaceVectorMember: uniqueIndex("idx_face_id_member_unique_vector").on(
      table.faceVectorId
    ),
    faceVectorIdIdx: index("idx_face_id_member_fv_id").on(table.faceVectorId),
  })
);

/**
 * A user-level correction: this face is valid, but it does not belong to
 * this particular identity. Keeping this separate from faceVectors.isRejected
 * lets later scans reuse the face for another person without undoing the
 * user's correction.
 */
export const faceIdentityExclusions = sqliteTable(
  "face_identity_exclusions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: integer("identity_id")
      .references(() => faceIdentities.id, { onDelete: "cascade" })
      .notNull(),
    faceVectorId: integer("face_vector_id")
      .references(() => faceVectors.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    uniqueIdentityFace: uniqueIndex("idx_face_identity_exclusion").on(
      table.identityId,
      table.faceVectorId
    ),
    identityIdIdx: index("idx_face_identity_exclusion_identity").on(
      table.identityId
    ),
    faceVectorIdIdx: index("idx_face_identity_exclusion_vector").on(
      table.faceVectorId
    ),
  })
);

/**
 * Stable user decisions for a detected face. Face vector ids are regenerated
 * during a rescan, so decisions must be keyed by the photo and detector face
 * index instead of only by face_vectors.id.
 */
export const faceReviewDecisions = sqliteTable(
  "face_review_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    photoId: integer("photo_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    faceIndex: integer("face_index").notNull(),
    decision: text("decision").notNull(),
    sourceIdentityId: integer("source_identity_id").references(
      () => faceIdentities.id,
      { onDelete: "set null" }
    ),
    sourceIdentityName: text("source_identity_name"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    uniquePhotoFace: uniqueIndex("idx_face_review_decision_photo_face").on(
      table.photoId,
      table.faceIndex
    ),
    photoIdIdx: index("idx_face_review_decision_photo_id").on(table.photoId),
    sourceIdentityIdx: index("idx_face_review_decision_source_identity").on(
      table.sourceIdentityId
    ),
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

/**
 * Versioned duplicate-detection fingerprints. The legacy photos.contentHash
 * column contains sampled values from older releases and remains untouched;
 * exact matching uses this table only after full verification.
 */
export const duplicatePhotoFingerprints = sqliteTable(
  "duplicate_photo_fingerprints",
  {
    photoId: integer("photo_id")
      .primaryKey()
      .references(() => photos.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    fileSize: integer("file_size").notNull(),
    modifiedAt: real("modified_at").notNull(),
    contentRevision: integer("content_revision").notNull().default(1),
    sampleHash: text("sample_hash"),
    fullSha256: text("full_sha256"),
    hashVersion: text("hash_version").notNull(),
    verifiedAt: integer("verified_at"),
  },
  (table) => ({
    hashIdx: index("idx_duplicate_fingerprint_hash").on(
      table.hashVersion,
      table.fullSha256
    ),
    photoPathIdx: index("idx_duplicate_fingerprint_path").on(table.path),
  })
);

/**
 * User review state is kept separate from detector output. A scan may update
 * its group version, but it must never overwrite an explicit photo decision.
 */
export const duplicateReviewGroups = sqliteTable(
  "duplicate_review_groups",
  {
    groupKey: text("group_key").primaryKey(),
    groupVersion: text("group_version").notNull(),
    detectionFingerprint: text("detection_fingerprint")
      .notNull()
      .default("legacy"),
    reviewRevision: integer("review_revision").notNull().default(0),
    ignoreState: text("ignore_state").notNull().default("ACTIVE"),
    complete: integer("complete", { mode: "boolean" }).notNull().default(false),
    needsReview: integer("needs_review", { mode: "boolean" })
      .notNull()
      .default(true),
    memberIdsJson: text("member_ids_json").notNull().default("[]"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    groupVersionIdx: index("idx_duplicate_review_group_version").on(
      table.groupVersion
    ),
    needsReviewIdx: index("idx_duplicate_review_group_needs_review").on(
      table.needsReview
    ),
  })
);

export const duplicateReviewMembers = sqliteTable(
  "duplicate_review_members",
  {
    groupKey: text("group_key")
      .references(() => duplicateReviewGroups.groupKey, {
        onDelete: "cascade",
      })
      .notNull(),
    photoId: integer("photo_id")
      .references(() => photos.id, { onDelete: "cascade" })
      .notNull(),
    decision: text("decision").notNull().default("UNDECIDED"),
    contentRevision: integer("content_revision").notNull().default(0),
    needsReview: integer("needs_review", { mode: "boolean" })
      .notNull()
      .default(true),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.groupKey, table.photoId] }),
    photoIdIdx: index("idx_duplicate_review_member_photo_id").on(table.photoId),
    decisionIdx: index("idx_duplicate_review_member_decision").on(
      table.decision
    ),
  })
);

export const duplicateReviewEvents = sqliteTable(
  "duplicate_review_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupKey: text("group_key").notNull(),
    groupVersion: text("group_version").notNull(),
    reviewRevision: integer("review_revision").notNull(),
    eventType: text("event_type").notNull(),
    photoId: integer("photo_id"),
    decision: text("decision"),
    contentRevision: integer("content_revision"),
    detailsJson: text("details_json"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    groupIdx: index("idx_duplicate_review_event_group").on(
      table.groupKey,
      table.createdAt
    ),
    photoIdx: index("idx_duplicate_review_event_photo").on(table.photoId),
  })
);

export const duplicateCleanupPlans = sqliteTable(
  "duplicate_cleanup_plans",
  {
    id: text("id").primaryKey(),
    configFingerprint: text("config_fingerprint").notNull().default("legacy"),
    status: text("status").notNull().default("READY"),
    expiresAt: integer("expires_at").notNull(),
    batchId: text("batch_id"),
    executedAt: integer("executed_at"),
    deletedCount: integer("deleted_count").notNull().default(0),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    statusIdx: index("idx_duplicate_cleanup_plan_status").on(table.status),
    batchIdx: uniqueIndex("idx_duplicate_cleanup_plan_batch").on(table.batchId),
  })
);

export const duplicateCleanupPlanItems = sqliteTable(
  "duplicate_cleanup_plan_items",
  {
    planId: text("plan_id")
      .references(() => duplicateCleanupPlans.id, { onDelete: "cascade" })
      .notNull(),
    groupKey: text("group_key").notNull(),
    groupVersion: text("group_version").notNull(),
    reviewRevision: integer("review_revision").notNull(),
    // This is an immutable audit snapshot. It intentionally has no live FK:
    // hard-deleting a photo after the trash window must not erase or block the
    // cleanup plan's evidence.
    photoId: integer("photo_id").notNull(),
    matchType: text("match_type").notNull(),
    decision: text("decision").notNull(),
    contentRevision: integer("content_revision").notNull(),
    path: text("path").notNull(),
    fileSize: integer("file_size").notNull(),
    modifiedAt: real("modified_at").notNull(),
    fileIdentity: text("file_identity"),
    fullSha256: text("full_sha256"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.planId, table.groupKey, table.photoId],
    }),
    photoIdx: index("idx_duplicate_cleanup_plan_item_photo").on(table.photoId),
    groupIdx: index("idx_duplicate_cleanup_plan_item_group").on(
      table.planId,
      table.groupKey
    ),
  })
);

export const duplicateCleanupEvents = sqliteTable(
  "duplicate_cleanup_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    planId: text("plan_id"),
    batchId: text("batch_id"),
    eventType: text("event_type").notNull(),
    photoId: integer("photo_id"),
    detailsJson: text("details_json"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    planIdx: index("idx_duplicate_cleanup_event_plan").on(
      table.planId,
      table.createdAt
    ),
    batchIdx: index("idx_duplicate_cleanup_event_batch").on(
      table.batchId,
      table.createdAt
    ),
    photoIdx: index("idx_duplicate_cleanup_event_photo").on(table.photoId),
  })
);

/**
 * Immutable input/configuration snapshot for a duplicate detection attempt.
 * The legacy detection_runs table only stores aggregate counters and cannot
 * prove which hash, threshold, model, or photo revision produced a result.
 */
export const duplicateDetectionRuns = sqliteTable(
  "duplicate_detection_runs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("running"),
    algorithmVersion: text("algorithm_version").notNull(),
    hashVersion: text("hash_version").notNull(),
    phashVersion: text("phash_version").notNull(),
    phashThreshold: real("phash_threshold").notNull(),
    embeddingModelVersion: text("embedding_model_version"),
    embeddingThreshold: real("embedding_threshold"),
    thresholdProfileVersion: text("threshold_profile_version").notNull(),
    photoRevision: text("photo_revision").notNull(),
    sequenceRevision: integer("sequence_revision").notNull(),
    vectorRevision: text("vector_revision").notNull(),
    settingsRevision: text("settings_revision").notNull(),
    configFingerprint: text("config_fingerprint").notNull(),
    startedAt: integer("started_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    completedAt: integer("completed_at"),
    errorMessage: text("error_message"),
  },
  (table) => ({
    statusIdx: index("idx_duplicate_detection_run_status").on(table.status),
    configIdx: index("idx_duplicate_detection_run_config").on(
      table.configFingerprint
    ),
    startedIdx: index("idx_duplicate_detection_run_started").on(
      table.startedAt
    ),
  })
);

/** Published result snapshots are isolated by detection run for auditability. */
export const duplicateRunGroups = sqliteTable(
  "duplicate_run_groups",
  {
    runId: text("run_id")
      .references(() => duplicateDetectionRuns.id, { onDelete: "cascade" })
      .notNull(),
    groupKey: text("group_key").notNull(),
    groupVersion: text("group_version").notNull(),
    matchType: text("match_type").notNull(),
    recommendedKeepId: integer("recommended_keep_id").notNull(),
    memberIdsJson: text("member_ids_json").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.runId, table.groupKey] }),
    groupIdx: index("idx_duplicate_run_group_key").on(table.groupKey),
  })
);

export const duplicateRunMembers = sqliteTable(
  "duplicate_run_members",
  {
    runId: text("run_id")
      .references(() => duplicateDetectionRuns.id, { onDelete: "cascade" })
      .notNull(),
    groupKey: text("group_key").notNull(),
    photoId: integer("photo_id").notNull(),
    contentRevision: integer("content_revision").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.runId, table.groupKey, table.photoId],
    }),
    photoIdx: index("idx_duplicate_run_member_photo").on(table.photoId),
  })
);

export const duplicateRunPairs = sqliteTable(
  "duplicate_run_pairs",
  {
    runId: text("run_id")
      .references(() => duplicateDetectionRuns.id, { onDelete: "cascade" })
      .notNull(),
    photoAId: integer("photo_a_id").notNull(),
    photoBId: integer("photo_b_id").notNull(),
    matchType: text("match_type").notNull(),
    phashDistance: integer("phash_distance"),
    clipSimilarity: real("clip_similarity"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.runId, table.photoAId, table.photoBId],
    }),
    photoAIdx: index("idx_duplicate_run_pair_photo_a").on(table.photoAId),
    photoBIdx: index("idx_duplicate_run_pair_photo_b").on(table.photoBId),
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
