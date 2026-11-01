# HEIF regression samples

- `example.heic`: https://github.com/strukturag/libheif/blob/master/examples/example.heic (1280×854 primary image, two top-level images). Upstream libheif is LGPL-3.0; the original file is unchanged.
- `rgb-10bit.heif`: https://github.com/bigcat88/pillow_heif/blob/master/tests/images/heif/RGB_10__128x128.heif (128×128, 10-bit). Upstream pillow-heif is BSD-3-Clause; the original file is unchanged.

Rotation, mirror, ICC and oversized-header cases are derived in memory from the first sample by the test helper. No user photos are included. Tests run offline.
