import { useCallback, useEffect, useState } from "react";
import type { GameCollection } from "@types";
import { ACCOUNTLESS } from "@shared";
import { IS_DESKTOP } from "../constants";

export function useGameCollections() {
  const [collections, setCollections] = useState<GameCollection[]>([]);

  const loadCollections = useCallback(async () => {
    if (!IS_DESKTOP) return;

    try {
      // Accountless fork: collections are stored locally, not on the profile.
      const response = ACCOUNTLESS
        ? await globalThis.window.electron.getGameCollections()
        : await globalThis.window.electron.hydraApi.get<GameCollection[]>(
            "/profile/games/collections",
            { needsAuth: true }
          );

      setCollections(Array.isArray(response) ? response : []);
    } catch {
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    if (!IS_DESKTOP) return undefined;

    void loadCollections();

    const unsubscribeBatch = globalThis.window.electron.onLibraryBatchComplete(
      () => {
        void loadCollections();
      }
    );

    const handleLibraryUpdate = () => {
      void loadCollections();
    };

    globalThis.window.addEventListener("library-update", handleLibraryUpdate);

    return () => {
      unsubscribeBatch();
      globalThis.window.removeEventListener(
        "library-update",
        handleLibraryUpdate
      );
    };
  }, [loadCollections]);

  return { collections, loadCollections };
}
