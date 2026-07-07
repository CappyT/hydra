import { registerEvent } from "../register-event";
import { getArtifactBackend } from "@main/services";

const renameGameArtifact = async (
  _event: Electron.IpcMainInvokeEvent,
  gameArtifactId: string,
  label: string
) => {
  const backend = await getArtifactBackend();
  await backend.rename(gameArtifactId, label);

  return { ok: true };
};

registerEvent("renameGameArtifact", renameGameArtifact);
