import type { Logging } from "homebridge";
import { PLUGIN_NAME } from "./settings.js";

// Homebridge tags its own warnings about this plugin with the package name, so tag ours the same way.
export function withPluginPrefix(log: Logging): Logging {
  const logger: Logging = Object.assign(
    (message: string, ...parameters: unknown[]) => logger.info(message, ...parameters),
    log,
    { prefix: PLUGIN_NAME },
  );
  return logger;
}
