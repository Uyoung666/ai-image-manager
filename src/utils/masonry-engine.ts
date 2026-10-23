import type {
  GroupHeaderInput,
  HeaderPosition,
  MasonryItem,
} from "@/hooks/useMasonryLayout";

export interface MasonryEngineInput {
  columns: number;
  colWidth: number;
  gap: number;
  headers: GroupHeaderInput[];
  heights?: number[];
  items: Array<{ width: number; height: number; fullWidth?: boolean }>;
  maxBottom?: number;
  showHeaders: boolean;
  start: number;
}
export interface MasonryCheckpoint {
  beforeIndex: number;
  heights: number[];
  maxBottom: number;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a single pass preserves shortest-column geometry, headers and full-width trays.
export function computeMasonryChunk(input: MasonryEngineInput) {
  const { items, colWidth, columns, gap, start, showHeaders } = input;
  const heights = input.heights
    ? [...input.heights]
    : new Array<number>(columns).fill(0);
  const headers = new Map(
    input.headers.map((header) => [header.beforeIndex, header.label])
  );
  const headerPositions: HeaderPosition[] = [];
  const data = new Float64Array(items.length * 5);
  let maxBottom = input.maxBottom ?? 0;
  const checkpoints: MasonryCheckpoint[] = [];
  for (let index = 0; index < items.length; index++) {
    if ((start + index) % 1000 === 0) {
      checkpoints.push({
        beforeIndex: start + index,
        heights: [...heights],
        maxBottom,
      });
    }
    const label = headers.get(start + index);
    if (label !== undefined) {
      const top = Math.max(...heights);
      headerPositions.push({ label, top });
      heights.fill(top + (showHeaders ? 36 + gap : 0));
    }
    const item = items[index];
    let column = 0;
    for (let next = 1; next < columns; next++) {
      if (heights[next] < heights[column]) {
        column = next;
      }
    }
    const width = item.fullWidth
      ? colWidth * columns + gap * (columns - 1)
      : colWidth;
    const height = item.fullWidth
      ? item.height
      : colWidth /
        Math.max(
          0.6,
          Math.min(
            3,
            item.width && item.height ? item.width / item.height : 4 / 3
          )
        );
    const top = item.fullWidth ? Math.max(...heights) : heights[column];
    maxBottom = Math.max(maxBottom, top + height);
    data.set(
      [
        top,
        item.fullWidth ? 0 : column * (colWidth + gap),
        width,
        height,
        maxBottom,
      ],
      index * 5
    );
    if (item.fullWidth) {
      heights.fill(top + height + gap);
    } else {
      heights[column] = top + height + gap;
    }
  }
  return { data, heights, headerPositions, maxBottom, checkpoints };
}

/** Fixed-size blocks support append without copying all earlier geometry. */
export class MasonryGeometryBlocks {
  private readonly blocks: Float64Array[] = [];
  length = 0;
  private readonly blockSize: number;
  constructor(blockSize = 1000) {
    this.blockSize = blockSize;
  }
  fork(): MasonryGeometryBlocks {
    const copy = new MasonryGeometryBlocks(this.blockSize);
    copy.blocks.push(...this.blocks);
    copy.length = this.length;
    const tail = copy.blocks.at(-1);
    if (this.length % this.blockSize !== 0 && tail) {
      copy.blocks[copy.blocks.length - 1] = tail.slice();
    }
    return copy;
  }
  append(data: Float64Array): void {
    for (let index = 0; index < data.length / 5; index++) {
      const position = this.length++;
      const block = Math.floor(position / this.blockSize);
      this.blocks[block] ??= new Float64Array(this.blockSize * 5);
      this.blocks[block].set(
        data.subarray(index * 5, index * 5 + 5),
        (position % this.blockSize) * 5
      );
    }
  }
  truncate(length: number): void {
    this.length = Math.min(this.length, Math.max(0, length));
    this.blocks.splice(Math.ceil(this.length / this.blockSize));
  }
  value(index: number, field: number): number {
    return this.blocks[Math.floor(index / this.blockSize)][
      (index % this.blockSize) * 5 + field
    ];
  }
  views(): { positions: MasonryItem[]; visibilityIndex: number[] } {
    const length = this.length;
    const create = <T>(read: (index: number) => T): T[] =>
      new Proxy(new Array<T>(length), {
        get: (target, property, receiver) => {
          const index =
            typeof property === "string" && ARRAY_INDEX.test(property)
              ? Number(property)
              : -1;
          return index >= 0 && index < length
            ? read(index)
            : Reflect.get(target, property, receiver);
        },
        has: (target, property) =>
          typeof property === "string" && ARRAY_INDEX.test(property)
            ? Number(property) < length
            : Reflect.has(target, property),
      });
    return {
      positions: create((index) => ({
        top: this.value(index, 0),
        left: this.value(index, 1),
        width: this.value(index, 2),
        height: this.value(index, 3),
      })),
      visibilityIndex: create((index) => this.value(index, 4)),
    };
  }
}
const ARRAY_INDEX = /^\d+$/;
