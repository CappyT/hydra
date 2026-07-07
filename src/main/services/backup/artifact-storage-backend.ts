import type {
  ArtifactUploadMeta,
  BackupBackendTestResult,
  GameShop,
  LocalArtifact,
} from "@types";

/**
 * Storage backend for save-game backups. Replaces the paid "Hydra Cloud"
 * artifact storage with user-controlled destinations while keeping every bit of
 * the existing ludusavi machinery (backup creation and the hand-rolled
 * cross-machine restore) untouched.
 *
 * Each artifact is materialised as a `.tar` (the ludusavi backup bundle) plus a
 * sidecar `.json` describing it ({@link LocalArtifact}). All operations run
 * fully logged-out — no {@link HydraApi} calls in the backup path.
 */
export interface ArtifactStorageBackend {
  /** Lists the artifacts stored for a given game. */
  list(shop: GameShop, objectId: string): Promise<LocalArtifact[]>;
  /**
   * Stores a freshly-bundled tar and writes its sidecar metadata. Returns the
   * created artifact (with a generated uuid id).
   */
  upload(tarPath: string, meta: ArtifactUploadMeta): Promise<LocalArtifact>;
  /**
   * Materialises the artifact tar locally and returns its path. Extraction and
   * restore are handled by the existing caller.
   */
  download(artifactId: string): Promise<string>;
  /** Removes the artifact tar and its sidecar. */
  delete(artifactId: string): Promise<void>;
  /** Updates the artifact label in its sidecar. */
  rename(artifactId: string, label: string): Promise<void>;
  /** Toggles the frozen flag in the artifact sidecar. */
  setFrozen(artifactId: string, frozen: boolean): Promise<void>;
  /** Verifies the backend is reachable/writable. */
  test(): Promise<BackupBackendTestResult>;
}
