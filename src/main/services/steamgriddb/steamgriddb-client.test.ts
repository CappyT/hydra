import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ArtworkItem } from "@types";

import {
  STEAMGRIDDB_PAGE_SIZE,
  emptyArtworkPage,
  mapArtworkResponse,
} from "./steamgriddb-client.ts";

const makeItem = (id: number): ArtworkItem => ({
  id,
  score: 0,
  url: `https://cdn.steamgriddb.com/grid/${id}.png`,
  thumb: `https://cdn.steamgriddb.com/thumb/${id}.png`,
  width: 600,
  height: 900,
});

const makeItems = (count: number) =>
  Array.from({ length: count }, (_, index) => makeItem(index + 1));

describe("SteamGridDB client artwork mapping", () => {
  it("maps a successful response 1:1 and marks the cache fresh", () => {
    const items = makeItems(3);

    const page = mapArtworkResponse(200, { success: true, data: items });

    assert.deepEqual(page.items, items);
    assert.equal(page.cache, "fresh");
    assert.equal(page.hasMore, false);
  });

  it("reports hasMore only when a full page is returned", () => {
    const fullPage = mapArtworkResponse(200, {
      success: true,
      data: makeItems(STEAMGRIDDB_PAGE_SIZE),
    });
    assert.equal(fullPage.hasMore, true);

    const partialPage = mapArtworkResponse(200, {
      success: true,
      data: makeItems(STEAMGRIDDB_PAGE_SIZE - 1),
    });
    assert.equal(partialPage.hasMore, false);
  });

  it("treats a 404 as an empty page", () => {
    assert.deepEqual(mapArtworkResponse(404, null), emptyArtworkPage());
  });

  it("treats 401/403 (invalid or missing key) as an empty page", () => {
    assert.deepEqual(mapArtworkResponse(401, undefined), emptyArtworkPage());
    assert.deepEqual(mapArtworkResponse(403, undefined), emptyArtworkPage());
  });

  it("tolerates a 2xx body without a data array", () => {
    const page = mapArtworkResponse(200, { success: true });

    assert.deepEqual(page.items, []);
    assert.equal(page.hasMore, false);
  });
});
