import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Game } from "@types";
import * as collectionActions from "../../../shared/library-group-actions.js";

const handlerCode = ts.transpileModule(
  fs.readFileSync(
    new URL("./set-collection-game-order.ts", import.meta.url),
    "utf8"
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }
).outputText;

type OrderHandler = (
  event: unknown,
  collectionId: string,
  games: { shop: string; objectId: string }[]
) => Promise<void>;

const game = (objectId: string, title: string): Game =>
  ({
    shop: "steam",
    objectId,
    title,
    isDeleted: false,
    collectionIds: ["local-1"],
  }) as Game;

const load = (accountless: boolean) => {
  const records = new Map<string, Game>([
    ["steam:a", game("a", "Alpha")],
    ["steam:b", game("b", "Beta")],
  ]);
  const apiCalls: string[] = [];
  const handlers = new Map<string, OrderHandler>();
  const run = <T>(operation: () => Promise<T>) => operation();
  const dependencies: Record<string, unknown> = {
    "@main/services/library-sync/library-write-queue": {
      LibraryWriteQueue: class {
        run = run;
      },
      libraryWriteQueue: { run },
      markCollectionOrderChanged: () => {},
    },
    "../register-event": {
      registerEvent: (name: string, handler: OrderHandler) =>
        handlers.set(name, handler),
    },
    "@main/level": {
      gamesSublevel: {
        values: () => ({ all: async () => [...records.values()] }),
        iterator: () => ({ all: async () => [...records.entries()] }),
        batch: async (updates: { key: string; value: Game }[]) => {
          for (const { key, value } of updates) records.set(key, value);
        },
      },
    },
    "@main/services": {
      HydraApi: {
        getAuthContext: () => null,
        isAuthContextCurrent: () => false,
        put: async (url: string) => {
          apiCalls.push(url);
          throw new Error("user/not-logged-in");
        },
      },
      logger: { error: () => {} },
    },
    "@shared": { ...collectionActions, ACCOUNTLESS: accountless },
  };
  runInNewContext(handlerCode, {
    exports: {},
    require: (id: string) => {
      assert.ok(
        Object.hasOwn(dependencies, id),
        `Unexpected dependency: ${id}`
      );
      return dependencies[id];
    },
  });
  return {
    records,
    apiCalls,
    handler: handlers.get("setCollectionGameOrder")!,
  };
};

const order = [
  { shop: "steam", objectId: "b" },
  { shop: "steam", objectId: "a" },
];

describe("setCollectionGameOrder", () => {
  it("saves the order locally without an API call when accountless", async () => {
    const { records, apiCalls, handler } = load(true);

    await handler(null, "local-1", order);

    assert.deepEqual(apiCalls, []);
    const positions = (key: string) =>
      records.get(key)?.collectionPositions?.["local-1"];
    assert.ok(positions("steam:b")! < positions("steam:a")!);
  });

  it("keeps the remote write when an account is used", async () => {
    const { records, apiCalls, handler } = load(false);

    await assert.rejects(handler(null, "local-1", order));

    assert.equal(apiCalls.length, 1);
    assert.equal(records.get("steam:a")?.collectionPositions, undefined);
  });
});
