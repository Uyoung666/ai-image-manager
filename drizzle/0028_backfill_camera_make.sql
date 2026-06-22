-- Backfill camera_make from camera_model or lens_model for existing
-- photos where the EXIF Make tag was empty. This mirrors the ingestion-
-- time fallback added in indexer.ts.

-- Step 1: Derive camera_make from camera_model when make is empty.
-- For iPhone/iPad models, map to "Apple"; otherwise use the first word.
UPDATE exif_data
SET camera_make = CASE
  WHEN LOWER(camera_model) LIKE 'iphone%' OR LOWER(camera_model) LIKE 'ipad%' THEN 'Apple'
  ELSE TRIM(SUBSTR(camera_model, 1, INSTR(camera_model || ' ', ' ') - 1))
END
WHERE (camera_make IS NULL OR camera_make = '')
  AND camera_model IS NOT NULL
  AND camera_model != '';

--> statement-breakpoint

-- Step 2: For rows where camera_model is also empty, try extracting
-- the make from lens_model (e.g. "iPhone 17 Pro Max back ..." → "Apple").
UPDATE exif_data
SET camera_make = CASE
  WHEN LOWER(lens_model) LIKE 'iphone%' OR LOWER(lens_model) LIKE 'ipad%' THEN 'Apple'
  ELSE TRIM(SUBSTR(lens_model, 1, INSTR(lens_model || ' ', ' ') - 1))
END
WHERE (camera_make IS NULL OR camera_make = '')
  AND lens_model IS NOT NULL
  AND lens_model != '';
