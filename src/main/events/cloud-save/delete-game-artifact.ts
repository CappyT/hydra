import { registerEvent } from "../register-event";
import { getArtifactBackend } from "@main/services";

const deleteGameArtifact = async (
  _event: Electron.IpcMainInvokeEvent,
  gameArtifactId: string
) => {
  const backend = await getArtifactBackend();
  await backend.delete(gameArtifactId);

  return { ok: true };
};

registerEvent("deleteGameArtifact", deleteGameArtifact);
