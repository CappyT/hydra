import { registerEvent } from "../register-event";
import { getArtifactBackend } from "@main/services";

const toggleArtifactFreeze = async (
  _event: Electron.IpcMainInvokeEvent,
  gameArtifactId: string,
  freeze: boolean
) => {
  const backend = await getArtifactBackend();
  await backend.setFrozen(gameArtifactId, freeze);

  return { ok: true };
};

registerEvent("toggleArtifactFreeze", toggleArtifactFreeze);
