import { describe, expect, it } from "vitest";
import {
  type FaceRepresentativeMember,
  selectFaceRepresentative,
} from "@/services/face-identity-representative";

const members: FaceRepresentativeMember[] = [
  { confidence: 0.7, photoId: 10, vectorId: 1 },
  { confidence: 0.95, photoId: 20, vectorId: 2 },
  { confidence: 0.95, photoId: 30, vectorId: 3 },
];

describe("face identity representative selection", () => {
  it("keeps the current valid representative stable", () => {
    expect(
      selectFaceRepresentative(members, {
        photoId: 10,
        vectorId: "1",
      })
    ).toEqual(members[0]);
  });

  it("uses the best face in the current photo when the current vector is gone", () => {
    expect(
      selectFaceRepresentative(
        [...members, { confidence: 0.8, photoId: 10, vectorId: 4 }],
        { photoId: 10, vectorId: "999" }
      )
    ).toEqual({ confidence: 0.8, photoId: 10, vectorId: 4 });
  });

  it("falls back deterministically to the highest-confidence remaining member", () => {
    expect(
      selectFaceRepresentative(members.slice(1), {
        photoId: 10,
        vectorId: "1",
      })
    ).toEqual(members[1]);
  });

  it("returns no representative for an empty group", () => {
    expect(
      selectFaceRepresentative([], { photoId: null, vectorId: null })
    ).toBeNull();
  });
});
