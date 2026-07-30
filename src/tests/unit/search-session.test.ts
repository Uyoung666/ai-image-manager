import { describe, expect, it } from "vitest";
import {
  appendToFrozenSearchPool,
  createSearchFingerprint,
  SearchSessionStore,
  takeFrozenSearchPage,
  takeUnemittedSearchResults,
} from "@/services/search-session";

describe("search session pagination", () => {
  it("keeps the fingerprint stable across offset, limit, and cursor changes", () => {
    const first = createSearchFingerprint({
      cursor: undefined,
      limit: 100,
      offset: 0,
      query: "自行车",
    });
    const next = createSearchFingerprint({
      cursor: "8af4bf7d-8d8e-44e3-834f-d67ed01f4f6d",
      limit: 200,
      offset: 100,
      query: "自行车",
    });

    expect(next).toBe(first);
  });

  it("expires idle sessions and evicts the least recently used session", () => {
    let now = 0;
    let sequence = 0;
    const store = new SearchSessionStore({
      createCursor: () => `cursor-${++sequence}`,
      maxSessions: 2,
      now: () => now,
      ttlMs: 100,
    });
    const first = store.create("first", 100);
    now = 10;
    const second = store.create("second", 100);
    now = 20;
    expect(store.get(first.cursor)).toBe(first);
    store.create("third", 100);

    expect(store.get(second.cursor)).toBeNull();
    expect(store.get(first.cursor)).toBe(first);
    now = 200;
    expect(store.get(first.cursor)).toBeNull();
  });

  it("never returns emitted IDs again when a deeper pool is reordered", () => {
    const store = new SearchSessionStore({
      createCursor: () => "cursor",
      now: () => 0,
    });
    const session = store.create("query", 100);
    const firstPage = takeUnemittedSearchResults(
      session,
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      2
    );
    for (const result of firstPage) {
      session.emittedIds.add(result.id);
    }
    const nextPage = takeUnemittedSearchResults(
      session,
      [{ id: 4 }, { id: 1 }, { id: 2 }, { id: 3 }],
      2
    );

    expect(firstPage.map(({ id }) => id)).toEqual([1, 2]);
    expect(nextPage.map(({ id }) => id)).toEqual([4, 3]);
  });

  it("keeps the frozen un-emitted prefix ahead of expanded candidates", () => {
    const store = new SearchSessionStore({
      createCursor: () => "cursor",
      now: () => 1,
    });
    const session = store.create("query", 200);
    appendToFrozenSearchPool(session, [
      { id: 1, rank: 1 },
      { id: 2, rank: 2 },
      { id: 3, rank: 3 },
    ]);

    expect(takeFrozenSearchPage(session, 2).map(({ id }) => id)).toEqual([
      1, 2,
    ]);
    session.emittedIds.add(1);
    session.emittedIds.add(2);
    appendToFrozenSearchPool(session, [
      { id: 4, rank: 1 },
      { id: 3, rank: 2 },
      { id: 5, rank: 3 },
    ]);

    expect(takeFrozenSearchPage(session, 10).map(({ id }) => id)).toEqual([
      3, 4, 5,
    ]);
  });
});
