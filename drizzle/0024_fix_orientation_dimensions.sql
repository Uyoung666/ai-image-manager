-- Fix photo dimensions for photos with rotated EXIF orientation.
-- sharp v0.34.x does not auto-rotate; before the orientation fix, width/height
-- stored in the photos table were the raw sensor dimensions (pre-rotation).
-- This swaps width/height for photos with 90° or 270° rotation (orientations 5-8).
UPDATE photos SET width = height, height = width
WHERE id IN (
  SELECT photo_id FROM exif_data
  WHERE orientation >= 5 AND orientation <= 8
);
