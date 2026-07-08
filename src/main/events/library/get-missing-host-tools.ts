import { getMissingHostTools } from "@main/helpers/host-dependencies";
import { registerEvent } from "../register-event";

registerEvent("getMissingHostTools", async () => {
  return getMissingHostTools();
});
