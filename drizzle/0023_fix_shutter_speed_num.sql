-- Fix shutter_speed_num: migration 0018 used CAST(shutter_speed AS REAL) which
-- fails for fraction strings like "1/1000" (CAST returns 0) and does not cover
-- photos imported after the migration (shutter_speed_num stays NULL).
-- This migration handles both "0.001" decimal strings and "1/1000" fraction strings.

-- Fix fraction-format shutter speeds (e.g. "1/1000", "1/60") where CAST to REAL
-- would give 0. Parse numerator/denominator and compute the division.
UPDATE exif_data
SET shutter_speed_num =
  CAST(SUBSTR(shutter_speed, 1, INSTR(shutter_speed, '/') - 1) AS REAL) /
  CAST(SUBSTR(shutter_speed, INSTR(shutter_speed, '/') + 1) AS REAL)
WHERE shutter_speed IS NOT NULL
  AND shutter_speed != ''
  AND INSTR(shutter_speed, '/') > 0
  AND INSTR(SUBSTR(shutter_speed, INSTR(shutter_speed, '/') + 1), '/') = 0
  AND (shutter_speed_num IS NULL OR shutter_speed_num = 0);--> statement-breakpoint

-- Fix decimal-format shutter speeds (e.g. "0.001", "0.008") where
-- shutter_speed_num is NULL (photos imported after migration 0018).
UPDATE exif_data
SET shutter_speed_num = CAST(shutter_speed AS REAL)
WHERE shutter_speed IS NOT NULL
  AND shutter_speed != ''
  AND INSTR(shutter_speed, '/') = 0
  AND shutter_speed_num IS NULL;--> statement-breakpoint

-- Fix focal_length_num for photos imported after migration 0018.
UPDATE exif_data
SET focal_length_num = CAST(focal_length AS REAL)
WHERE focal_length IS NOT NULL
  AND focal_length != ''
  AND focal_length_num IS NULL;
