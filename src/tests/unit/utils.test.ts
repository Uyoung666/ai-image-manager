import { describe, expect, it } from "vitest";

// Test hammingDistance utility (extracted from handlers.ts)
function hammingDistance(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const xor = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

// Test formatFileSize (from PhotoDetailPanel)
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Test getTagColor
function getTagColor(name: string): string {
  const colors = [
    "#5e6ad2",
    "#46a758",
    "#ffb224",
    "#e5484d",
    "#7c7fe0",
    "#3b9ec6",
    "#d97a3e",
    "#a855f7",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

describe("hammingDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(hammingDistance("abc123", "abc123")).toBe(0);
  });

  it("returns >0 for different strings", () => {
    const dist = hammingDistance("abc123", "def456");
    expect(dist).toBeGreaterThan(0);
  });

  it("handles different length strings", () => {
    expect(() => hammingDistance("abc", "abcdef")).not.toThrow();
  });

  it("is symmetric", () => {
    const a = "abc123def";
    const b = "abc456def";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(1500)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("getTagColor", () => {
  it("returns a valid hex color", () => {
    const color = getTagColor("风景");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns same color for same name", () => {
    expect(getTagColor("风景")).toBe(getTagColor("风景"));
  });

  it("returns different colors for different names (usually)", () => {
    // It's possible (but unlikely) for two different names to hash to the same color
    const colors = new Set(["风景", "人像", "动物", "建筑"].map(getTagColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});
