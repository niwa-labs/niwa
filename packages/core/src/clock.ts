/**
 * The clock of one host: where the time comes from, and how work is scheduled on it.
 *
 * One host has one clock. Everything that asks what time it is, or that waits for a moment to
 * come, asks the clock of its host: the service that schedules the timers, the invocation that
 * reads the time as a step, the host that stamps the moments it writes. A test can therefore
 * move the time of a host and watch what the host does with it, without waiting in real time.
 */

/** The clock of one host. */
export interface Clock {
  /** The moment now, in milliseconds since the epoch. */
  now(): number;
  /**
   * Run `fn` at the moment `at`, in milliseconds since the epoch.
   *
   * The returned function cancels it: a moment that will not come must not fire.
   */
  schedule(at: number, fn: () => void | Promise<void>): () => void;
}

/** The longest delay one timer of the real clock may be given: a longer one overflows. */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * The clock of the world outside: the real time, and the real timers.
 *
 * A moment far away is armed in pieces: a timer of a runtime takes a signed 32-bit delay, and
 * a moment a year away does not fit into one.
 */
export function realClock(): Clock {
  return {
    now: (): number => Date.now(),
    schedule: (at, fn) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const arm = (): void => {
        const delay = Math.max(at - Date.now(), 0);
        timer = setTimeout(
          () => {
            if (cancelled) return;
            // The delay did not fit into one timer: the moment is not here yet.
            if (Date.now() < at) {
              arm();
              return;
            }
            // A callback that fails must not become an unhandled rejection of the process.
            void Promise.resolve()
              .then(fn)
              .catch((error: unknown) => {
                console.error(
                  `niwa: a scheduled callback failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          },
          Math.min(delay, MAX_DELAY_MS),
        );
      };
      arm();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}
