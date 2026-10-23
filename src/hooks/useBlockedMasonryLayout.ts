import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { getGalleryGeometryKey } from "@/utils/gallery-data-source";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import {
  computeMasonryChunk,
  type MasonryCheckpoint,
  type MasonryEngineInput,
  MasonryGeometryBlocks,
} from "@/utils/masonry-engine";
import { computeMasonryInWorker } from "@/utils/masonry-worker-client";
import type {
  GroupHeaderInput,
  MasonryLayout,
  MasonryLayoutInput,
} from "./useMasonryLayout";

interface Cache {
  checkpoints: MasonryCheckpoint[];
  context: string;
  count: number;
  headers: MasonryLayout["headerPositions"];
  heights: number[];
  items: MasonryLayoutInput[];
  key: string;
  layout: MasonryLayout;
  route: string;
  source: string;
  store: MasonryGeometryBlocks;
}
const empty: MasonryLayout = {
  positions: [],
  visibilityIndex: [],
  headerPositions: [],
  totalHeight: 0,
};

export function useBlockedMasonryLayout(
  items: MasonryLayoutInput[],
  width: number,
  columns: number,
  gap: number,
  headers: GroupHeaderInput[] | undefined,
  route: string,
  showHeaders: boolean
): MasonryLayout | null {
  const source = getGalleryGeometryKey(items);
  const key = `${source}:${width}:${columns}:${gap}:${route}:${showHeaders}:${headers?.[0]?.label ?? ""}`;
  const context = `${width}:${columns}:${gap}:${route}:${showHeaders}:${headers?.[0]?.label ?? ""}`;
  const committed = useRef<Cache | null>(null);
  const [ready, setReady] = useState<Cache | null>(null);
  const previous = committed.current;
  const full = !previous || previous.key !== key;
  const start = useMemo(() => {
    if (!previous) {
      return 0;
    }
    if (!full) {
      return Math.min(previous.count, items.length);
    }
    if (previous.context !== context) {
      return 0;
    }
    let same = 0;
    while (same < Math.min(items.length, previous.items.length)) {
      const a = items[same];
      const b = previous.items[same];
      if (
        a.id !== b.id ||
        a.width !== b.width ||
        a.height !== b.height ||
        a.fileDate !== b.fileDate ||
        a.fullWidth !== b.fullWidth
      ) {
        break;
      }
      same++;
    }
    return (
      Math.floor(same / GALLERY_CONFIG.layoutBlockSize) *
      GALLERY_CONFIG.layoutBlockSize
    );
  }, [full, context, previous, items]);
  const checkpoint = previous?.checkpoints.find(
    (entry) => entry.beforeIndex === start
  );
  const async = Boolean(
    source &&
      width > 0 &&
      columns > 0 &&
      items.length > GALLERY_CONFIG.layoutWorkerThreshold &&
      full
  );
  const input = useMemo<MasonryEngineInput>(
    () => ({
      items: source
        ? items.slice(start).map(({ width, height, fullWidth }) => ({
            width,
            height,
            fullWidth,
          }))
        : [],
      colWidth: columns > 0 ? (width - (columns - 1) * gap) / columns : 0,
      columns,
      gap,
      start,
      heights:
        start > 0 ? (checkpoint?.heights ?? previous?.heights) : undefined,
      maxBottom: start > 0 ? previous?.store.value(start - 1, 4) : 0,
      headers: (headers ?? []).filter((header) => header.beforeIndex >= start),
      showHeaders,
    }),
    [
      headers,
      width,
      items.slice,
      columns,
      showHeaders,
      source,
      items,
      gap,
      start,
      checkpoint,
      previous,
    ]
  );
  useEffect(() => {
    if (!(async && source)) {
      return;
    }
    let current = true;
    const started = performance.now();
    computeMasonryInWorker(input)
      .catch(() => computeMasonryChunk(input))
      .then((result) => {
        if (!current) {
          return;
        }
        const store =
          start > 0 && previous
            ? previous.store.fork()
            : new MasonryGeometryBlocks();
        store.truncate(start);
        store.append(result.data);
        const priorHeaderCount = (headers ?? []).filter(
          (header) => header.beforeIndex < start
        ).length;
        const allHeaders = [
          ...(previous?.headers.slice(0, priorHeaderCount) ?? []),
          ...result.headerPositions,
        ];
        const layout = {
          ...store.views(),
          headerPositions: allHeaders,
          totalHeight: Math.max(0, ...result.heights),
        };
        setReady({
          key,
          route,
          context,
          items,
          checkpoints: [
            ...(previous?.checkpoints.filter(
              (point) => point.beforeIndex < start
            ) ?? []),
            ...result.checkpoints,
          ],
          source,
          count: items.length,
          store,
          heights: result.heights,
          headers: allHeaders,
          layout,
        });
        recordGalleryPerf("masonryWorkerMs", performance.now() - started);
      });
    return () => {
      current = false;
    };
  }, [
    async,
    source,
    key,
    input,
    items.length,
    start,
    previous,
    headers,
    context,
    items,
    route,
  ]);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: select one atomic layout from committed, appended or worker-prepared geometry.
  const computed = useMemo<Cache | null>(() => {
    if (!source || width <= 0 || columns <= 0) {
      return null;
    }
    if (ready?.key === key && ready.count === items.length) {
      return ready;
    }
    if (async) {
      return previous?.route === route ? previous : null;
    }
    if (previous?.key === key && previous.count === items.length) {
      return previous;
    }
    const started = performance.now();
    const store =
      start > 0 && previous
        ? previous.store.fork()
        : new MasonryGeometryBlocks();
    store.truncate(start);
    const result = computeMasonryChunk({
      ...input,
      start,
      heights:
        start > 0 ? (checkpoint?.heights ?? previous?.heights) : undefined,
      maxBottom: start > 0 && previous ? previous.store.value(start - 1, 4) : 0,
      headers: input.headers.filter((header) => header.beforeIndex >= start),
    });
    store.append(result.data);
    const priorHeaderCount = (headers ?? []).filter(
      (header) => header.beforeIndex < start
    ).length;
    const allHeaders = [
      ...(previous?.headers.slice(0, priorHeaderCount) ?? []),
      ...result.headerPositions,
    ];
    recordGalleryPerf("masonryLayoutMs", performance.now() - started);
    return {
      key,
      route,
      context,
      items,
      checkpoints: [
        ...(previous?.checkpoints.filter(
          (point) => point.beforeIndex < start
        ) ?? []),
        ...result.checkpoints,
      ],
      source,
      count: items.length,
      store,
      heights: result.heights,
      headers: allHeaders,
      layout: {
        ...store.views(),
        headerPositions: allHeaders,
        totalHeight: Math.max(0, ...result.heights),
      },
    };
  }, [
    source,
    key,
    ready,
    async,
    previous,
    items.length,
    input,
    width,
    columns,
    start,
    checkpoint,
    headers,
    context,
    items,
    route,
  ]);
  useLayoutEffect(() => {
    if (computed && computed.key === key) {
      committed.current = computed;
    }
  }, [computed, key]);
  if (!source) {
    return null;
  }
  return computed ? { ...computed.layout, renderItems: computed.items } : empty;
}
