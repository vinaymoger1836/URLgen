/**
 * The click consumer as its own process.
 *
 * Same wiring as the API's embedded flusher, no HTTP server. This exists because
 * the buffer allows exactly one flusher and the API is the thing you want to scale
 * horizontally — running the consumer separately lets you add API replicas without
 * either duplicating the flusher or having to remember not to.
 *
 * `CLICK_CONSUMER_ENABLED` is forced on here: this process has no other purpose,
 * so starting it with the flag off and silently doing nothing would be the worst
 * possible outcome.
 */

import { pino } from "pino";

import { buildClickPipeline } from "../analytics/pipeline.js";
import { ConfigError, loadConfig, redactConfig } from "../config.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      /* No logger yet — it needs a config. stderr is all there is. */
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const log = pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss Z" } } }
      : {}),
  });

  const shutdownHooks: (() => Promise<void>)[] = [];

  buildClickPipeline(
    {
      log,
      onShutdown: (hook) => shutdownHooks.push(hook),
    },
    { ...config, CLICK_CONSUMER_ENABLED: true },
  );

  log.info({ config: redactConfig(config) }, "click consumer started");

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "shutting down click consumer");

    void Promise.all(shutdownHooks.map((hook) => hook())).then(
      () => process.exit(0),
      (error: unknown) => {
        log.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /* The flusher's timer is unref'd so it cannot hold a container open during a
     deploy. This interval is what keeps the process alive on purpose, and it is
     the only thing that should. */
  setInterval(() => {
    /* Intentionally empty: a keep-alive handle, not a task. */
  }, 60_000);
}

main();
