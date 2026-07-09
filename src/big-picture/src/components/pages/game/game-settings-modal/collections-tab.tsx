import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { GameCollection, LibraryGame } from "@types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Checkbox,
  EmptyState,
  HorizontalFocusGroup,
  Input,
  VerticalFocusGroup,
} from "../../../common";
import { ConfirmationModal } from "../../../modals";
import { useBigPictureToast } from "../../../../hooks";
import { SettingsSection } from "../../../../pages/settings/settings-section";

import "./collections-tab.scss";

export const GAME_COLLECTIONS_SETTINGS_PRIMARY_CONTROL_ID =
  "game-collections-settings-primary-control";

const GAME_COLLECTIONS_SETTINGS_CREATE_BUTTON_ID =
  "game-collections-settings-create-button";

function getCollectionToggleFocusId(collectionId: string) {
  return `game-collections-settings-toggle-${collectionId}`;
}

function getCollectionDeleteFocusId(collectionId: string) {
  return `game-collections-settings-delete-${collectionId}`;
}

interface GameCollectionsSettingsProps {
  game: LibraryGame;
}

export function GameCollectionsSettingsTab({
  game,
}: Readonly<GameCollectionsSettingsProps>) {
  const { t } = useTranslation(["game_details", "sidebar", "library"]);
  const { showSuccessToast, showErrorToast } = useBigPictureToast();

  const [collections, setCollections] = useState<GameCollection[]>([]);
  const [collectionIds, setCollectionIds] = useState<string[]>(
    game.collectionIds ?? []
  );
  const [newCollectionName, setNewCollectionName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingCollectionId, setPendingCollectionId] = useState<string | null>(
    null
  );
  const [deleteTarget, setDeleteTarget] = useState<GameCollection | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setCollectionIds(game.collectionIds ?? []);
  }, [game.collectionIds]);

  const loadCollections = useCallback(async () => {
    try {
      const result = await globalThis.window.electron.getGameCollections();
      setCollections(Array.isArray(result) ? result : []);
    } catch {
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  const sortedCollections = useMemo(
    () =>
      [...collections].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      ),
    [collections]
  );

  const handleToggleCollection = useCallback(
    async (collectionId: string) => {
      if (pendingCollectionId) return;

      const isAssigned = collectionIds.includes(collectionId);
      const nextCollectionIds = isAssigned
        ? collectionIds.filter((id) => id !== collectionId)
        : [...collectionIds, collectionId];

      setPendingCollectionId(collectionId);

      try {
        await globalThis.window.electron.assignGameToCollection(
          game.shop,
          game.objectId,
          nextCollectionIds
        );
        setCollectionIds(nextCollectionIds);
        showSuccessToast(t("game_collection_updated", { ns: "game_details" }));
      } catch {
        showErrorToast(
          t("failed_update_game_collection", { ns: "game_details" })
        );
      } finally {
        setPendingCollectionId(null);
      }
    },
    [
      collectionIds,
      game.objectId,
      game.shop,
      pendingCollectionId,
      showErrorToast,
      showSuccessToast,
      t,
    ]
  );

  const handleCreateCollection = useCallback(async () => {
    const name = newCollectionName.trim();
    if (!name || creating) return;

    const alreadyExists = collections.some(
      (collection) =>
        collection.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (alreadyExists) {
      showErrorToast(t("collection_name_already_in_use", { ns: "sidebar" }));
      return;
    }

    setCreating(true);

    try {
      await globalThis.window.electron.createGameCollection(name);
      await loadCollections();
      setNewCollectionName("");
      showSuccessToast(t("collection_created", { ns: "sidebar" }));
    } catch {
      showErrorToast(t("failed_create_collection", { ns: "sidebar" }));
    } finally {
      setCreating(false);
    }
  }, [
    collections,
    creating,
    loadCollections,
    newCollectionName,
    showErrorToast,
    showSuccessToast,
    t,
  ]);

  const handleDeleteCollection = useCallback(async () => {
    if (!deleteTarget) return;

    setDeleting(true);

    try {
      await globalThis.window.electron.deleteGameCollection(deleteTarget.id);
      setCollectionIds((current) =>
        current.filter((id) => id !== deleteTarget.id)
      );
      await loadCollections();
      showSuccessToast(t("collection_deleted", { ns: "library" }));
      setDeleteTarget(null);
    } catch {
      showErrorToast(t("failed_delete_collection", { ns: "library" }));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, loadCollections, showErrorToast, showSuccessToast, t]);

  return (
    <VerticalFocusGroup className="game-collections-settings-tab">
      <SettingsSection
        className="game-collections-settings-tab__section"
        title={t("create_collection", { ns: "sidebar" })}
        description={t("create_collection_description", { ns: "sidebar" })}
      >
        <HorizontalFocusGroup
          className="game-collections-settings-tab__create-row"
          asChild
        >
          <div>
            <Input
              focusId={GAME_COLLECTIONS_SETTINGS_PRIMARY_CONTROL_ID}
              className="game-collections-settings-tab__create-input"
              value={newCollectionName}
              placeholder={t("collection_name_placeholder", { ns: "sidebar" })}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              disabled={creating}
              onChange={(event) => setNewCollectionName(event.target.value)}
            />
            <Button
              focusId={GAME_COLLECTIONS_SETTINGS_CREATE_BUTTON_ID}
              variant="primary"
              icon={<PlusIcon size={16} />}
              loading={creating}
              disabled={!newCollectionName.trim() || creating}
              focusNavigationOverrides={{
                left: {
                  type: "item",
                  itemId: GAME_COLLECTIONS_SETTINGS_PRIMARY_CONTROL_ID,
                },
              }}
              onClick={() => {
                void handleCreateCollection();
              }}
            >
              {creating
                ? t("creating_collection", { ns: "sidebar" })
                : t("create", { ns: "sidebar" })}
            </Button>
          </div>
        </HorizontalFocusGroup>
      </SettingsSection>

      <SettingsSection
        className="game-collections-settings-tab__section"
        title={t("collections", { ns: "sidebar" })}
        description={t("create_collection_description", { ns: "sidebar" })}
      >
        {sortedCollections.length === 0 ? (
          <EmptyState
            title={t("collections", { ns: "sidebar" })}
            description={t("no_collections_created_yet", { ns: "sidebar" })}
          />
        ) : (
          <div className="game-collections-settings-tab__list">
            {sortedCollections.map((collection) => (
              <HorizontalFocusGroup
                key={collection.id}
                className="game-collections-settings-tab__row"
                asChild
              >
                <div>
                  <Checkbox
                    id={getCollectionToggleFocusId(collection.id)}
                    focusId={getCollectionToggleFocusId(collection.id)}
                    label={collection.name}
                    checked={collectionIds.includes(collection.id)}
                    disabled={pendingCollectionId === collection.id}
                    block
                    onChange={() => {
                      void handleToggleCollection(collection.id);
                    }}
                  />
                  <Button
                    focusId={getCollectionDeleteFocusId(collection.id)}
                    variant="danger"
                    size="icon"
                    aria-label={t("delete_collection", { ns: "library" })}
                    focusNavigationOverrides={{
                      left: {
                        type: "item",
                        itemId: getCollectionToggleFocusId(collection.id),
                      },
                    }}
                    onClick={() => setDeleteTarget(collection)}
                  >
                    <TrashIcon size={16} />
                  </Button>
                </div>
              </HorizontalFocusGroup>
            ))}
          </div>
        )}
      </SettingsSection>

      <ConfirmationModal
        visible={deleteTarget !== null}
        title={t("delete_collection_title", { ns: "library" })}
        description={t("delete_collection_description", {
          ns: "library",
          collectionName: deleteTarget?.name ?? "",
        })}
        confirmLabel={t("delete_collection", { ns: "library" })}
        danger
        loading={deleting}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => {
          void handleDeleteCollection();
        }}
      />
    </VerticalFocusGroup>
  );
}
