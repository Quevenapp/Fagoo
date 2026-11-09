import { type Actor, type Env, ApiError } from "./types";
import {
  createCloudflareJob,
  retryCloudflareJob,
  saveCloudflareSettings,
} from "./cloudflare";
import {
  configureUpdates,
  configureAutomaticUpdates,
  resetUpdate,
  startUpdate,
} from "./updates";
import { configurePush } from "./push";
export async function maintenanceCommand(
  env: Env,
  actor: Actor,
  operation: string,
  data: any,
) {
  switch (operation) {
    case "system.cloudflare.save":
      return saveCloudflareSettings(env, actor, data);
    case "system.cloudflare.create":
      return createCloudflareJob(env, actor, data);
    case "system.cloudflare.retry":
      return retryCloudflareJob(env, actor, data.id);
    case "system.updates.configure":
      return configureUpdates(env, actor, data);
    case "system.updates.automatic":
      return configureAutomaticUpdates(env, actor, data);
    case "system.updates.start":
      return startUpdate(env, actor, data);
    case "system.updates.reset":
      return resetUpdate(env, actor, data);
    case "system.push.configure":
      return configurePush(env, actor, data);
    default:
      throw new ApiError(
        400,
        "unknown_operation",
        "Operação de manutenção desconhecida.",
      );
  }
}
