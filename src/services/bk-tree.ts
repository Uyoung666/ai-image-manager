// Popcount for 32-bit unsigned integers (SWAR algorithm)
const NIBBLE_BITS = [
  "0000",
  "0001",
  "0010",
  "0011",
  "0100",
  "0101",
  "0110",
  "0111",
  "1000",
  "1001",
  "1010",
  "1011",
  "1100",
  "1101",
  "1110",
  "1111",
];
const NIBBLE_DISTANCE = NIBBLE_BITS.map((left) =>
  NIBBLE_BITS.map((right) =>
    [...left].reduce(
      (distance, bit, index) => distance + (bit === right[index] ? 0 : 1),
      0
    )
  )
);

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64;
  }
  // Split 64-bit phash into two 32-bit halves and use native XOR + popcount.
  // This avoids BigInt overhead (~3us/call → ~0.05us/call, ~60x faster).
  let distance = 0;
  for (let index = 0; index < 16; index++) {
    const left = Number.parseInt(a[index], 16);
    const right = Number.parseInt(b[index], 16);
    distance += NIBBLE_DISTANCE[left]?.[right] ?? 0;
  }
  return distance;
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
      const node = stack.pop();
      if (!node) {
        continue;
      }
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
