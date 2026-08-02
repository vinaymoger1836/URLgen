/** Process entry point: load config, fail fast if it is wrong, then serve. */

import { ConfigError, loadConfig, redactConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      /* The logger needs a config, which we do not have — stderr is all we get. */
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = buildServer(config);
  app.log.info({ config: redactConfig(config) }, "starting urlgen api");

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (error) {
    app.log.error({ err: error }, "failed to start");
    process.exit(1);
  }
}

void main();
