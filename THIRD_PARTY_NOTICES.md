# Third-party notices

## ASCII Sharks

The built-in ASCII Ocean theme adapts the simulation and Canvas renderer from
[stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks) at revision
`a0074c16a106f0abc665fe9712ca445f8f98ad8e`.
Copyright (c) 2026 drewdi. Distributed under the MIT license; the complete text
is bundled in `licenses/ASCII-Sharks-MIT.txt`. The host adds ocean palettes,
settings, bounded rendering, background-only interaction and lifecycle handling.

## Lucide Animated

Selected icon animation designs are adapted from [pqoqubbw/icons](https://github.com/pqoqubbw/icons)
at revision `4662fff2b60fdcf4751b32013606756caf7c4c26`. Most icons retain their
Lucide geometry; selected navigation icons use the upstream SVG geometry.
The host adds shared triggers, bounded timing, and reduced-motion
support. See the bundled `licenses/Lucide-Animated-MIT.txt` for the MIT license
and Lucide geometry notices. Motion is distributed under its MIT license.

## DSH Transparent UI Plugin

The Aqua fluid shader recipe used by the built-in Nebula Glass theme is
adapted from
[DSH-Transparent-UI-Plugin](https://github.com/WYH66666666/DSH-Transparent-UI-Plugin).

Copyright (c) 2026 John Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## About page: Skiper UI and Open Peeps

The free Skiper UI components 52 (gallery), 58 (rolling text) and 39 (crowd)
are credited on the about page. The crowd was adapted by Gurvinder Singh
(@gurvinder-singh02) from Zadvorsky's animation and uses Open Peeps
illustrations by Pablo Stanley (CC0 1.0). GSAP uses its Standard License.
See the bundled licenses/About-UI.txt for source and license references.

## About page: Uiverse

The creator card, browser preview and copy feedback are adapted from MIT-licensed designs by Smit-Prajapati, arthur_6104 and Galahhad. Sources and full terms are bundled in licenses/About-UI.txt.

## HEIC/HEIF decoding

The offline decoder uses the unmodified WASM distribution of [libheif-js](https://github.com/catdad-experiments/libheif-js), version 1.23.5, which includes libheif and its HEVC decoder. It is distributed under LGPL-3.0. Upstream source and build instructions are available from that repository and the package's pinned release.

License texts are included in `licenses/HEIF-LGPL-3.0.txt` and `licenses/HEIF-LIBRARIES.txt`. The runtime distribution, including its upstream license files, remains separate under `resources/app.asar.unpacked/node_modules/libheif-js/`.
