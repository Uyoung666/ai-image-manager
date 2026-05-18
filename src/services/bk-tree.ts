export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64;
  }
  try {
    const va = BigInt(`0x${a}`);
    const vb = BigInt(`0x${b}`);
    let xor = va ^ vb;
    let dist = 0;
    while (xor > 0n) {
      dist += Number(xor & 1n);
      xor >>= 1n;
    }
    return dist;
  } catch {
    return 64;
  }
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
