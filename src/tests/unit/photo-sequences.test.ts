import { describe, expect, it } from "vitest";
import {
  detectSequenceCandidates,
  type SequenceDetectionCandidate,
} from "@/services/photo-sequences";

const START = 1_700_000_000_000;

function candidate(
  id: number,
  offset: number,
  overrides: Partial<SequenceDetectionCandidate> = {}
): SequenceDetectionCandidate {
  return {
    id,
    folderId: 1,
    capturedAt: START + offset,
    camera: "Camera A",
    lens: "Lens A",
    phash: "0000000000000000",
    burstGroupId: null,
    burstFrameNumber: null,
    isContinuousDrive: false,
    ...overrides,
  };
}

describe("high-confidence photo sequence detection", () => {
  it("detects only a visually continuous burst with one trusted group id", () => {
    const sequences = detectSequenceCandidates([
      candidate(1, 0, { burstGroupId: "burst-a" }),
      candidate(2, 400, { burstGroupId: "burst-a", phash: "0000000000000001" }),
      candidate(3, 800, { burstGroupId: "burst-a", phash: "0000000000000003" }),
    ]);

    expect(sequences).toMatchObject([
      { type: "burst", members: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ]);
  });

  it("rejects burst candidates with a different id, missing hash, time break, or changed capture context", () => {
    const scenarios: SequenceDetectionCandidate[][] = [
      [
        candidate(1, 0, { burstGroupId: "a" }),
        candidate(2, 300, { burstGroupId: "b" }),
        candidate(3, 600, { burstGroupId: "a" }),
      ],
      [
        candidate(1, 0, { burstGroupId: "a" }),
        candidate(2, 300, { burstGroupId: "a", phash: null }),
        candidate(3, 600, { burstGroupId: "a" }),
      ],
      [
        candidate(1, 0, { burstGroupId: "a" }),
        candidate(2, 2001, { burstGroupId: "a" }),
        candidate(3, 2400, { burstGroupId: "a" }),
      ],
      [
        candidate(1, 0, { burstGroupId: "a" }),
        candidate(2, 300, { burstGroupId: "a", lens: "Lens B" }),
        candidate(3, 600, { burstGroupId: "a" }),
      ],
    ];

    for (const entries of scenarios) {
      expect(detectSequenceCandidates(entries)).toEqual([]);
    }
  });

  it("does not treat a drive mode or incrementing sequence number as a burst group", () => {
    expect(
      detectSequenceCandidates([
        candidate(1, 0),
        candidate(2, 300),
        candidate(3, 600),
      ])
    ).toEqual([]);
  });

  it("detects a continuous-drive burst only when frame numbers, precise time, and visual evidence agree", () => {
    const sequences = detectSequenceCandidates([
      candidate(1, 0, { burstFrameNumber: 1, isContinuousDrive: true }),
      candidate(2, 133, {
        burstFrameNumber: 2,
        isContinuousDrive: true,
        phash: "0000000000000003",
      }),
      candidate(3, 266, {
        burstFrameNumber: 3,
        isContinuousDrive: true,
        phash: "000000000000000f",
      }),
    ]);

    expect(sequences).toMatchObject([
      { type: "burst", members: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ]);
  });

  it("breaks a continuous-drive burst when its frame counter restarts", () => {
    expect(
      detectSequenceCandidates([
        candidate(1, 0, { burstFrameNumber: 1, isContinuousDrive: true }),
        candidate(2, 133, { burstFrameNumber: 2, isContinuousDrive: true }),
        candidate(3, 266, { burstFrameNumber: 1, isContinuousDrive: true }),
      ])
    ).toEqual([]);
  });

  it("detects a six-frame timelapse only when time and visual chains remain stable", () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      candidate(index + 1, index * 10_000, {
        phash: `${index}`.padStart(16, "0"),
      })
    );

    expect(detectSequenceCandidates(entries)).toMatchObject([
      {
        type: "timelapse",
        members: [
          { id: 1 },
          { id: 2 },
          { id: 3 },
          { id: 4 },
          { id: 5 },
          { id: 6 },
        ],
      },
    ]);
  });

  it("accepts a five-second intervalometer's small early-trigger jitter and gradual visual change", () => {
    const entries = [0, 4924, 9920, 14_883, 19_875, 24_838].map(
      (offset, index) =>
        candidate(index + 1, offset, {
          phash: index % 2 === 0 ? "0000000000000000" : "0000000000003fff",
        })
    );

    expect(detectSequenceCandidates(entries)).toMatchObject([
      {
        type: "timelapse",
        members: [
          { id: 1 },
          { id: 2 },
          { id: 3 },
          { id: 4 },
          { id: 5 },
          { id: 6 },
        ],
      },
    ]);
  });

  it("rejects short, visually discontinuous, burst-tagged, and irregular timelapse candidates", () => {
    const stable = Array.from({ length: 6 }, (_, index) =>
      candidate(index + 1, index * 10_000)
    );
    const scenarios: SequenceDetectionCandidate[][] = [
      stable.slice(0, 5),
      stable.map((entry, index) =>
        index === 3 ? { ...entry, phash: "ffffffffffffffff" } : entry
      ),
      stable.map((entry, index) =>
        index === 2 ? { ...entry, burstGroupId: "burst-a" } : entry
      ),
      stable.map((entry, index) =>
        index === 3 ? { ...entry, capturedAt: entry.capturedAt + 3000 } : entry
      ),
    ];

    for (const entries of scenarios) {
      expect(detectSequenceCandidates(entries)).toEqual([]);
    }
  });

  it("accepts the 15 percent interval boundary with the one-second minimum tolerance", () => {
    const entries = [0, 10_000, 21_500, 31_500, 41_500, 51_500].map(
      (offset, index) => candidate(index + 1, offset)
    );

    expect(detectSequenceCandidates(entries)[0]?.type).toBe("timelapse");
  });

  it("splits a 500-frame five-second intervalometer at a nine-minute pause instead of creating many fragments", () => {
    let offset = 0;
    const entries = Array.from({ length: 500 }, (_, index) => {
      if (index === 250) {
        offset += 9 * 60_000;
      }
      const entry = candidate(index + 1, offset, {
        phash: index % 3 === 0 ? "0000000000000000" : "0000000000000003",
      });
      offset += 4924 + (index % 76);
      return entry;
    });

    const sequences = detectSequenceCandidates(entries);
    expect(sequences).toHaveLength(2);
    expect(sequences.map((sequence) => sequence.members)).toEqual([
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
      expect.arrayContaining([expect.objectContaining({ id: 251 })]),
    ]);
    expect(sequences.map((sequence) => sequence.members.length)).toEqual([
      250, 250,
    ]);
  });

  it("keeps one timelapse when up to two integer-multiple intervals are missing", () => {
    const entries = [0, 5000, 10_000, 25_000, 30_000, 35_000].map(
      (offset, index) => candidate(index + 1, offset)
    );
    expect(detectSequenceCandidates(entries)[0]?.members).toHaveLength(6);
  });
});
