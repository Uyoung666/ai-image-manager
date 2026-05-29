// Popcount for 32-bit unsigned integers (SWAR algorithm)
function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64;
  }
  // Split 64-bit phash into two 32-bit halves and use native XOR + popcount.
  // This avoids BigInt overhead (~3us/call → ~0.05us/call, ~60x faster).
  const aHi = Number.parseInt(a.slice(0, 8), 16);
  const aLo = Number.parseInt(a.slice(8, 16), 16);
  const bHi = Number.parseInt(b.slice(0, 8), 16);
  const bLo = Number.parseInt(b.slice(8, 16), 16);
  return popcount32((aHi ^ bHi) >>> 0) + popcount32((aLo ^ bLo) >>> 0);
}

interface BKNode {
  children: Map<number, BKNode>;
  phash: string;
  photoId: number;
}

export interface BKNeighbor {
  distance: number;
  phash: string;
  photoId: number;
}

export class BKTree {
  private root: BKNode | null = null;
  private size = 0;

  get count(): number {
    return this.size;
  }

  insert(photoId: number, phash: string): void {
    const node: BKNode = { photoId, phash, children: new Map() };
    if (!this.root) {
      this.root = node;
      this.size++;
      return;
    }
    let current = this.root;
    while (true) {
      const dist = hammingDistance(current.phash, phash);
      if (dist === 0 && current.photoId !== photoId) {
        const child = current.children.get(0);
        if (!child) {
          current.children.set(0, node);
          this.size++;
          return;
        }
        current = child;
      } else {
        const child = current.children.get(dist);
        if (!child) {
          current.children.set(dist, node);
          this.size++;
          return;
        }
        current = child;
      }
    }
  }

  query(phash: string, threshold: number): BKNeighbor[] {
    if (!this.root) {
      return [];
    }
    const results: BKNeighbor[] = [];
    const stack: BKNode[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      const dist = hammingDistance(node.phash, phash);
      if (dist <= threshold) {
        results.push({
          photoId: node.photoId,
          phash: node.phash,
          distance: dist,
        });
      }
      const low = dist - threshold;
      const high = dist + threshold;
      for (const [childDist, child] of node.children) {
        if (childDist >= low && childDist <= high) {
          stack.push(child);
        }
      }
    }
    return results;
  }
}
