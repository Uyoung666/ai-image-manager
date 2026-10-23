import type { Photo } from "@/types/photo";
import { GALLERY_CONFIG } from "./gallery-config";
import { recordGalleryPerf } from "./gallery-perf";

export interface GalleryLayoutEntry {
  fileDate?: number | null;
  height: number | null;
  id: number;
  isFavorite?: boolean | null;
  match?: Photo["match"];
  width: number | null;
}
const GEOMETRY_FIELDS = 6;
type PhotoLoader = (ids: number[]) => Promise<Photo[]>;
const sources = new WeakMap<
  object,
  { source: GalleryDataSource; index: number }
>();
const geometryViews = new WeakMap<object, string>();
const contexts = new Map<
  string,
  { source: GalleryDataSource; touched: number }
>();
const listeners = new Set<() => void>();
const evictions = new Set<(key: string) => void>();
const registry = new Map<string, WeakRef<GalleryDataSource>>();
const collected = new FinalizationRegistry<{
  key: string;
  ref: WeakRef<GalleryDataSource>;
}>(({ key, ref }) => {
  if (registry.get(key) === ref) {
    registry.delete(key);
  }
});
export function subscribeGalleryEvictions(
  listener: (key: string) => void
): () => void {
  evictions.add(listener);
  return () => {
    evictions.delete(listener);
  };
}
export function getGalleryPhotoSourceKey(photo: object): string | undefined {
  return sources.get(photo)?.source.key;
}
function retireContext(key: string, source: GalleryDataSource): void {
  source.clearRecords(true);
  contexts.delete(key);
  for (const listener of evictions) {
    listener(key);
  }
}
function activateContext(source: GalleryDataSource): void {
  contexts.delete(source.key);
  while (contexts.size >= GALLERY_CONFIG.maxContexts) {
    const oldest = contexts.entries().next().value;
    if (oldest) {
      retireContext(oldest[0], oldest[1].source);
    }
  }
  contexts.set(source.key, { source, touched: Date.now() });
}
let version = 0;
export const subscribeGalleryData = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getGalleryDataVersion = () => version;
export function isWindowedGalleryPhoto(photo: object): boolean {
  return sources.has(photo);
}
function publish() {
  version++;
  for (const listener of listeners) {
    listener();
  }
}
const photoKeys: Array<keyof Photo> = [
  "id",
  "width",
  "height",
  "fileDate",
  "path",
  "filename",
  "fileSize",
  "thumbnailPath",
  "thumbnailVersion",
  "isIndexed",
  "isFavorite",
  "dominantColors",
  "match",
];

/** Numeric geometry stays resident; rich Photo records live in an independent bounded LRU. */
export class GalleryDataSource {
  readonly photos: Photo[] = [];
  private readonly blocks: Float64Array[] = [];
  private readonly idToIndex = new Map<number, number>();
  private readonly pages = new Map<
    number,
    { items: Map<number, Photo>; bytes: number }
  >();
  private readonly loading = new Map<number, Promise<void>>();
  private readonly records = new Map<number, Photo>();
  private readonly recordPages = new Map<number, number>();
  private readonly recordSizes = new Map<number, number>();
  private nextPage = 0;
  private pinned = new Set<number>();
  private bytes = 0;
  private epoch = 0;
  private retired = false;
  readonly key: string;
  private readonly load: PhotoLoader;
  constructor(key: string, load: PhotoLoader) {
    this.key = key;
    this.load = load;
  }

  append(items: GalleryLayoutEntry[], hydrated: Photo[] = []): Photo[] {
    const result: Photo[] = [];
    for (const entry of items) {
      let index = this.idToIndex.get(entry.id);
      if (index !== undefined && entry.isFavorite !== undefined) {
        this.blocks[Math.floor(index / GALLERY_CONFIG.layoutBlockSize)][
          (index % GALLERY_CONFIG.layoutBlockSize) * GEOMETRY_FIELDS + 4
        ] = Number(entry.isFavorite);
      }
      if (index === undefined) {
        index = this.photos.length;
        this.idToIndex.set(entry.id, index);
        const block = Math.floor(index / GALLERY_CONFIG.layoutBlockSize);
        this.blocks[block] ??= new Float64Array(
          GALLERY_CONFIG.layoutBlockSize * GEOMETRY_FIELDS
        );
        this.blocks[block].set(
          [
            entry.id,
            entry.width ?? 0,
            entry.height ?? 0,
            entry.fileDate ?? Number.NaN,
            Number(entry.isFavorite ?? false),
            entry.match?.kind === "tagFilter"
              ? Number(entry.match.origin === "manual") + 1
              : 0,
          ],
          (index % GALLERY_CONFIG.layoutBlockSize) * GEOMETRY_FIELDS
        );
        const target = { source: this, index };
        const photo = new Proxy(
          target,
          GalleryDataSource.photoHandler
        ) as unknown as Photo;
        sources.set(photo, target);
        this.photos.push(photo);
      }
      result.push(this.photos[index]);
    }
    if (hydrated.length > 0) {
      this.cache(hydrated);
    }
    recordGalleryPerf(
      "galleryLayoutBytes",
      this.blocks.length * GALLERY_CONFIG.layoutBlockSize * GEOMETRY_FIELDS * 8
    );
    return result;
  }

  private static readonly photoHandler: ProxyHandler<{
    source: GalleryDataSource;
    index: number;
  }> = {
    get: (target, property) =>
      target.source.readPhotoField(target.index, property),
    ownKeys: () => photoKeys,
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  };

  private readPhotoField(position: number, property: string | symbol): unknown {
    const geometry =
      this.blocks[Math.floor(position / GALLERY_CONFIG.layoutBlockSize)];
    const offset =
      (position % GALLERY_CONFIG.layoutBlockSize) * GEOMETRY_FIELDS;
    if (property === "id") {
      return geometry[offset];
    }
    if (property === "width") {
      return geometry[offset + 1];
    }
    if (property === "height") {
      return geometry[offset + 2];
    }
    if (property === "fileDate") {
      return Number.isNaN(geometry[offset + 3]) ? null : geometry[offset + 3];
    }
    if (property === "isFavorite") {
      return geometry[offset + 4] === 1;
    }
    if (property === "match" && geometry[offset + 5] > 0) {
      return {
        kind: "tagFilter",
        origin: geometry[offset + 5] === 2 ? "manual" : "auto",
      };
    }
    const cached = this.records.get(geometry[offset]);
    if (cached) {
      return Reflect.get(cached, property);
    }
    if (property === "isIndexed") {
      return true;
    }
    if (property === "fileSize") {
      return 0;
    }
    if (property === "path" || property === "filename") {
      return "";
    }
    if (property === "thumbnailPath") {
      return null;
    }
    return undefined;
  }

  private cache(items: Photo[], evict = true): void {
    let bucketKey = 0;
    for (const item of items) {
      const index = this.idToIndex.get(item.id);
      if (index === undefined) {
        continue;
      }
      const block =
        this.blocks[Math.floor(index / GALLERY_CONFIG.layoutBlockSize)];
      const offset = (index % GALLERY_CONFIG.layoutBlockSize) * GEOMETRY_FIELDS;
      block[offset + 4] = Number(item.isFavorite ?? false);
      if (item.match?.kind === "tagFilter") {
        block[offset + 5] = Number(item.match.origin === "manual") + 1;
      }
      const size = JSON.stringify(item).length * 2;
      let pageKey = this.recordPages.get(item.id);
      if (pageKey === undefined) {
        const bucket = this.pages.get(bucketKey);
        if (!bucket || bucket.items.size >= GALLERY_CONFIG.pageSize) {
          bucketKey = ++this.nextPage;
          this.pages.set(bucketKey, { items: new Map(), bytes: 0 });
        }
        pageKey = bucketKey;
      }
      const page = this.pages.get(pageKey);
      if (!page) {
        continue;
      }
      const difference = size - (this.recordSizes.get(item.id) ?? 0);
      page.bytes += difference;
      this.bytes += difference;
      page.items.set(item.id, item);
      this.records.set(item.id, item);
      this.recordPages.set(item.id, pageKey);
      this.recordSizes.set(item.id, size);
      this.pages.delete(pageKey);
      this.pages.set(pageKey, page);
    }
    if (evict) {
      this.evict();
    }
  }

  private removeRecord(id: number): void {
    const key = this.recordPages.get(id);
    const page = key === undefined ? undefined : this.pages.get(key);
    const size = this.recordSizes.get(id) ?? 0;
    if (page) {
      page.items.delete(id);
      page.bytes -= size;
      if (page.items.size === 0 && key !== undefined) {
        this.pages.delete(key);
      }
    }
    this.bytes -= size;
    this.records.delete(id);
    this.recordSizes.delete(id);
    this.recordPages.delete(id);
  }

  private overBudget(): boolean {
    return (
      this.pages.size > GALLERY_CONFIG.maxPages ||
      this.bytes > GALLERY_CONFIG.maxPhotoBytes
    );
  }

  private evictUnpinned(): void {
    for (const [key, page] of this.pages) {
      if (!this.overBudget()) {
        break;
      }
      if ([...page.items.keys()].some((id) => this.pinned.has(id))) {
        continue;
      }
      for (const id of page.items.keys()) {
        this.removeRecord(id);
      }
      this.pages.delete(key);
    }
  }

  private evict(): void {
    this.evictUnpinned();
    if (this.overBudget()) {
      // Sparse photo-mode views can span many physical source pages. Pack their
      // pinned records together so page count remains bounded as well as bytes.
      const keep = [...this.pinned].flatMap((id) => this.records.get(id) ?? []);
      for (const photo of keep) {
        this.removeRecord(photo.id);
      }
      this.cache(keep, false);
      this.evictUnpinned();
    }
    while (this.overBudget()) {
      const oldest = this.pages.values().next().value;
      if (!oldest) {
        break;
      }
      for (const id of oldest.items.keys()) {
        this.removeRecord(id);
      }
    }
    recordGalleryPerf("galleryResidentPages", this.pages.size);
    recordGalleryPerf("galleryResidentPhotoBytes", this.bytes);
    recordGalleryPerf("galleryResidentPhotos", this.records.size);
  }

  async ensureRange(start: number, end: number, pin = false): Promise<void> {
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(this.photos.length - 1, Math.floor(end));
    await this.ensureIndices(
      Array.from(
        { length: Math.max(0, last - first + 1) },
        (_, offset) => first + offset
      ),
      pin
    );
  }

  getIndex(id: number): number | undefined {
    return this.idToIndex.get(id);
  }
  updateFavorites(ids: number[], favorite: boolean): void {
    for (const id of ids) {
      const index = this.idToIndex.get(id);
      if (index === undefined) {
        continue;
      }
      const block =
        this.blocks[Math.floor(index / GALLERY_CONFIG.layoutBlockSize)];
      block[(index % GALLERY_CONFIG.layoutBlockSize) * GEOMETRY_FIELDS + 4] =
        Number(favorite);
      const photo = this.records.get(id);
      if (photo) {
        this.cache([{ ...photo, isFavorite: favorite }]);
      }
    }
  }
  async readRecords(ids: number[]): Promise<Photo[]> {
    const records: Photo[] = [];
    for (let index = 0; index < ids.length; index += 1000) {
      records.push(...(await this.load(ids.slice(index, index + 1000))));
    }
    return records;
  }
  async ensureIndices(indices: number[], pin: boolean): Promise<void> {
    if (this.retired) {
      activateContext(this);
      this.retired = false;
    }
    const context = contexts.get(this.key);
    if (context) {
      context.touched = Date.now();
    }
    const valid = indices.filter(
      (index) => index >= 0 && index < this.photos.length
    );
    if (pin) {
      this.pinned = new Set(valid.map((index) => this.photos[index].id));
    }
    const missingPages = new Set<number>();
    for (const index of valid) {
      const id = this.photos[index].id;
      const key = this.recordPages.get(id);
      const page = key === undefined ? undefined : this.pages.get(key);
      if (page && key !== undefined) {
        this.pages.delete(key);
        this.pages.set(key, page);
      } else {
        missingPages.add(Math.floor(index / GALLERY_CONFIG.pageSize));
      }
    }
    for (const page of missingPages) {
      let task = this.loading.get(page);
      if (!task) {
        const epoch = this.epoch;
        const ids = this.photos
          .slice(
            page * GALLERY_CONFIG.pageSize,
            (page + 1) * GALLERY_CONFIG.pageSize
          )
          .map((photo) => photo.id);
        task = this.load(ids)
          .then((records) => {
            if (this.epoch === epoch) {
              this.cache(records);
              publish();
            }
          })
          .finally(() => {
            if (this.loading.get(page) === task) {
              this.loading.delete(page);
            }
          });
        this.loading.set(page, task);
      }
      await task;
    }
    this.evict();
  }
  getStats() {
    return {
      pages: this.pages.size,
      bytes: this.bytes,
      count: this.photos.length,
    };
  }
  clearRecords(retire = false): void {
    this.retired = retire;
    this.epoch++;
    this.pages.clear();
    this.records.clear();
    this.recordPages.clear();
    this.recordSizes.clear();
    this.nextPage = 0;
    this.loading.clear();
    this.bytes = 0;
    this.pinned.clear();
  }
}

export function galleryContext(
  key: string,
  load: PhotoLoader
): GalleryDataSource {
  const now = Date.now();
  for (const [name, entry] of contexts) {
    if (now - entry.touched > GALLERY_CONFIG.contextTtlMs) {
      retireContext(name, entry.source);
    }
  }
  const existing = contexts.get(key);
  if (existing) {
    contexts.delete(key);
    contexts.set(key, { ...existing, touched: now });
    return existing.source;
  }
  const remembered = registry.get(key)?.deref();
  if (remembered) {
    activateContext(remembered);
    return remembered;
  }
  const source = new GalleryDataSource(key, load);
  const reference = new WeakRef(source);
  registry.set(key, reference);
  collected.register(source, { key, ref: reference });
  activateContext(source);
  return source;
}

export async function ensureGalleryPhotos(
  photos: ReadonlyArray<{ id: number }>,
  pin = false
): Promise<void> {
  const ranges = new Map<GalleryDataSource, number[]>();
  for (const photo of photos) {
    const entry = sources.get(photo);
    if (!entry) {
      continue;
    }
    const indices = ranges.get(entry.source) ?? [];
    indices.push(entry.index);
    ranges.set(entry.source, indices);
  }
  await Promise.all(
    [...ranges].map(([source, indices]) => source.ensureIndices(indices, pin))
  );
}

export function clearGalleryContexts(): void {
  for (const entry of contexts.values()) {
    retireContext(entry.source.key, entry.source);
  }
  contexts.clear();
  registry.clear();
}
export function updateGalleryFavorites(ids: number[], favorite: boolean): void {
  for (const context of contexts.values()) {
    context.source.updateFavorites(ids, favorite);
  }
  publish();
}
if (typeof window !== "undefined") {
  const sweep = setInterval(() => {
    for (const [key, context] of contexts) {
      if (Date.now() - context.touched > GALLERY_CONFIG.contextTtlMs) {
        retireContext(key, context.source);
      }
    }
  }, 60_000);
  window.addEventListener("pagehide", () => {
    clearInterval(sweep);
    clearGalleryContexts();
  });
}

/** Resolve an explicit operation's IDs without pinning its entire selection in the page cache. */
export async function readGalleryPhotoRecords(
  items: Photo[]
): Promise<Photo[]> {
  const groups = new Map<GalleryDataSource, number[]>();
  for (const item of items) {
    const entry = sources.get(item);
    if (entry) {
      const ids = groups.get(entry.source) ?? [];
      ids.push(item.id);
      groups.set(entry.source, ids);
    }
  }
  const records = new Map<number, Photo>();
  for (const [source, ids] of groups) {
    for (const item of await source.readRecords(ids)) {
      records.set(item.id, item);
    }
  }
  return items.flatMap((item) =>
    sources.has(item) ? (records.get(item.id) ?? []) : item
  );
}

export function getGalleryGeometryKey(
  items: ReadonlyArray<{ id: number }>
): string | null {
  const known = geometryViews.get(items);
  if (known) {
    return known;
  }
  const first = sources.get(items[0]);
  const last = sources.get(items.at(-1) as object);
  return first &&
    last &&
    first.source === last.source &&
    last.index - first.index === items.length - 1
    ? `${first.source.key}:${first.index}`
    : null;
}

export function registerGalleryGeometryView<T extends { id: number }>(
  view: T[],
  original: ReadonlyArray<{ id: number }>,
  variant: string
): T[] {
  const base = getGalleryGeometryKey(original);
  if (base) {
    geometryViews.set(view, `${base}:${variant}`);
  }
  return view;
}
