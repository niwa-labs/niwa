/**
 * pause.ts — the wait between two reconnect attempts of a subscription.
 */

/** Delay between reconnect attempts of a subscription whose connection dropped. */
export const RECONNECT_INTERVAL_MS = 100;

/**
 * One wait at a time that a cancel cuts short. When the wait ends, by the timer or by the cancel,
 * nothing of it is left: no timer, no handler waiting for a later cancel.
 */
export class RetryPause {
  private end: (() => void) | null = null;

  wait(ms: number = RECONNECT_INTERVAL_MS): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.cancel(), ms);
      this.end = () => {
        clearTimeout(timer);
        this.end = null;
        resolve();
      };
    });
  }

  /** End the wait now, if there is one. */
  cancel(): void {
    this.end?.();
  }
}
