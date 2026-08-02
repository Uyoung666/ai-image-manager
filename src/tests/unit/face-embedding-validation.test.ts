import { describe, expect, it } from "vitest";
import {
  filterValidFaceEmbeddings,
  selectReplaceableFaceResults,
} from "@/services/face-detector";

describe("face embedding batch validation", () => {
  it("skips one malformed face while keeping valid faces in the batch", () => {
    const result = filterValidFaceEmbeddings(
      [
        {
          id: 1,
          faces: [
            {
              faceIndex: 0,
              bbox: { x: 1, y: 2, width: 3, height: 4 },
              confidence: 0.9,
              embedding: [0.1, 0.2],
            },
            {
              faceIndex: 1,
              bbox: { x: 5, y: 6, width: 7, height: 8 },
              confidence: 0.8,
              embedding: [0.1],
            },
          ],
        },
      ],
      2
    );

    expect(result.invalidFaces).toBe(1);
    expect(result.results[0]?.faces).toHaveLength(1);
    expect(result.results[0]?.faces[0]?.faceIndex).toBe(0);
  });

  it("never replaces stored faces for failed or partially invalid photos", () => {
    const original = [
      {
        id: 1,
        faces: [
          {
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            confidence: 0.9,
            embedding: [1, 0],
            faceIndex: 0,
          },
        ],
      },
      {
        id: 2,
        error: "worker failed",
        faces: [],
      },
      {
        id: 3,
        faces: [
          {
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            confidence: 0.9,
            embedding: [1],
            faceIndex: 0,
          },
        ],
      },
    ];
    const filtered = filterValidFaceEmbeddings(original, 2);

    expect(
      selectReplaceableFaceResults(original, filtered.results).map(
        (result) => result.id
      )
    ).toEqual([1]);
  });
});
