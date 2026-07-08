import { isNetworkIsolationAvailable } from "@main/services/sandbox-network";
import { registerEvent } from "../register-event";

registerEvent("isNetworkIsolationAvailable", async () => {
  return isNetworkIsolationAvailable();
});
