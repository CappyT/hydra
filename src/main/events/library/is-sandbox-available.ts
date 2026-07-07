import { Sandbox } from "@main/services";
import { registerEvent } from "../register-event";

registerEvent("isSandboxAvailable", async () => {
  return Sandbox.isAvailable();
});
