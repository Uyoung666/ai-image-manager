-- Backfill camera_model from lens_model for phone photos where
-- the EXIF Model tag was empty but LensModel contains the device name.
-- Typical phone lens model: "iPhone 17 Pro Max back triple camera 6.765mm f/1.78"
-- We extract the substring before " back " as the camera model.

UPDATE exif_data
SET camera_model = TRIM(SUBSTR(lens_model, 1, INSTR(lens_model, ' back ') - 1))
WHERE (camera_model IS NULL OR camera_model = '')
  AND lens_model IS NOT NULL
  AND lens_model != ''
  AND INSTR(lens_model, ' back ') > 0;

--> statement-breakpoint

-- Fallback: for remaining rows with empty camera_model, use camera_make
-- (e.g., "Apple", "OPPO") as a minimal camera model identifier.
UPDATE exif_data
SET camera_model = camera_make
WHERE (camera_model IS NULL OR camera_model = '')
  AND camera_make IS NOT NULL
  AND camera_make != '';
