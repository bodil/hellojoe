declare const require: (module: string) => any;

const cluster = require("cluster");
const child = require("child_process");
const merge = require("merge");

const defaultCores = require("os").cpus().length;

const defaultLogger = {
  info: console.log,
  debug: console.log,
  warn: console.error,
  handleExceptions: () => {}
};

export interface Logger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  handleExceptions: () => void;
}

export interface ScaleOptions {
  /**
   * Custom logger. Defaults to an implementation using `console.log`.
   */
  logger: Logger;
  /**
   * Number of worker processes to spawn.
   */
  cores?: number;
  /**
   * Number of failures permitted before retryDelay activates.
   */
  retryThreshold?: number;
  /**
   * After a certain number of failures, delay this long before restarting workers.
   */
  retryDelay?: number;
  /**
   * If a process runs for less than this time, it's considered a failure.
   */
  failureThreshold?: number;
  /**
   * Optional path to a worker executable, in which case this Hello Joe instance
   * will spawn workers using the `child_process` module, as opposed to the
   * `cluster` module, and the passed `app` function will be ignored, implying
   * that sockets will not be automatically shared among processes.
   */
  worker?: string;
  /**
   * Command line arguments for worker executable. Must be specified if
   * `worker` is present.
   */
  workerArgs?: string[];
}

export function serve(options: ScaleOptions, app?: () => void): void {
  let startTimes = {}, failures = 0;
  options = merge({
    logger: defaultLogger,
    cores: defaultCores,
    retryThreshold: 23,
    retryDelay: 10000,
    failureThreshold: 5000
  }, options);
  const log = options.logger;

  function pid(worker) {
    return options.worker ? worker.pid : worker.process.pid;
  }

  function spawnMore() {
    let worker;
    if (options.worker) {
      worker = child.fork(options.worker, options.workerArgs);
      log.debug("Spawning worker %s as child process: %j %j",
                pid(worker), options.worker, options.workerArgs);
    } else {
      worker = cluster.fork();
      log.debug("Spawning worker in cluster:", pid(worker));
    }

    startTimes[pid(worker)] = Date.now();
    if (!options.worker) {
      worker.on("listening", (addr) =>
                log.info("Process", pid(worker), "is now listening on",
                         addr.address + ":" + addr.port));
    }

    // Enable Erlang mode
    worker.on("exit", (code, signal) => {
      const lifetime = Date.now() - startTimes[pid(worker)];
      let replacement;
      delete startTimes[pid(worker)];

      if (worker.suicide) {
        log.info("Worker", pid(worker), "terminated voluntarily.");
        return;
      }

      log.info("Process", pid(worker), "terminated with signal", signal,
                  "code", code + "; restarting.");

      if (lifetime < options.failureThreshold) {
        failures++;
      } else {
        failures = 0;
      }

      if (failures > options.retryThreshold) {
        log.warn(failures + " consecutive failures; pausing for",
                 options.retryDelay + "ms before respawning.");
      }

      setTimeout(() => {
        replacement = spawnMore();
        replacement.on("online", () =>
                       log.info("Process", replacement.process.pid,
                                "has successfully replaced", pid(worker)));
      }, (failures > options.retryThreshold) ? options.retryDelay : 0);
    });

    return worker;
  }

  if (cluster.isMaster) {
    // Spawn more overlords
    for (let i = 0; i < options.cores; i++) {
      spawnMore();
    }

    log.info("Spawned", options.cores, options.worker ? "worker processes."
             : "server instances.");
  } else {
    log.handleExceptions();
    options.worker || app();
  }
}
