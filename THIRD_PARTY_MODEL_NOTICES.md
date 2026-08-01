# Third-party model notices

## SigLIP Base Patch16-224

- Upstream model: `google/siglip-base-patch16-224`
- ONNX conversion: `Xenova/siglip-base-patch16-224`
- Purpose: local image/text embeddings for semantic search and automatic tags
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0. A copy of
that license is included at `licenses/SigLIP-Apache-2.0.txt`.

Source:

- https://huggingface.co/google/siglip-base-patch16-224
- https://huggingface.co/Xenova/siglip-base-patch16-224

The model is provided without warranties or conditions of any kind. This
notice must remain with source and binary distributions that include the
SigLIP weights.

## OPUS-MT Chinese to English

- Upstream model: `Helsinki-NLP/opus-mt-zh-en`
- ONNX conversion: `Xenova/opus-mt-zh-en`
- Pinned conversion revision: `92737ae29cee287d5b7dc400c52afb9407207640`
- Purpose: local, offline Chinese-to-English query translation
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)

The model is based on the OPUS multilingual parallel corpus and was trained
by the Language Technology Research Group at the University of Helsinki.
The application does not send or persist translation queries.

Source:

- https://huggingface.co/Helsinki-NLP/opus-mt-zh-en
- https://huggingface.co/Xenova/opus-mt-zh-en
- https://creativecommons.org/licenses/by/4.0/

The required attribution and a link to the license are included at
`licenses/OPUS-MT-CC-BY-4.0.txt`.

## CLIP ViT-B/32

- Upstream model: `openai/clip-vit-base-patch32`
- ONNX conversion: `Xenova/clip-vit-base-patch32`
- Purpose: local image/text embeddings for compatibility and auxiliary search
- License: MIT

The model weights are redistributed under the MIT License. A copy of that
license is included at `licenses/CLIP-MIT.txt`.

Source:

- https://github.com/openai/CLIP
- https://huggingface.co/Xenova/clip-vit-base-patch32

## UltraFace 320 (legacy detector)

- Upstream: Linzaer's Ultra-Light-Fast-Generic-Face-Detector-1MB
- File: `face/ultraface-320.onnx`
- Purpose: explicit legacy detector fallback only; it is not the old w600k
  recognition model
- License: MIT

A copy of the upstream MIT license is included at
`licenses/UltraFace-MIT.txt`.

Source:

- https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB

## YuNet Face Detection

- Upstream: Shiqi Yu's libfacedetection training (YuNet)
- ONNX conversion: OpenCV Zoo `face_detection_yunet`
- Purpose: local, offline face detection with 5-point landmarks
- License: MIT

The model weights are redistributed under the MIT License. A copy of that
license is included at `licenses/YuNet-MIT.txt`.

Source:

- https://github.com/ShiqiYu/libfacedetection
- https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet

## SFace Face Recognition

- Upstream: SFace — Sigmoid-Constrained Hypersphere Loss (Yaoyao Zhong)
- ONNX conversion: OpenCV Zoo `face_recognition_sface`
- Purpose: local, offline face embedding (128-d) for identity clustering
- License: Apache License 2.0

The model weights are redistributed under the Apache License 2.0. A copy of
that license is included at `licenses/SFace-Apache-2.0.txt`.

Source:

- https://github.com/zhongyy/SFace
- https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface

The model is provided without warranties or conditions of any kind. This
notice must remain with source and binary distributions that include the
SFace weights.
