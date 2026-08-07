/**
 * An in-process click buffer for tests.
 *
 * Deliberately mirrors the Redis implementation's semantics rather than being
 * convenient: the cap drops instead of growing, a drain *moves* rows to an
 * in-flight list instead of removing them, an unacknowledged batch is handed back
 * unchanged on the next drain, and only `ack()` discards. Phase 1 cost a day to a
 * fake that returned more than the real store could — a double that is more
 * capable than the thing it doubles hides exactly the bugs it was built to catch.
 */

import type { ClickRow } from "../analytics/click-row.js";
import type { ClickBatch, ClickBuffer, PushOutcome } from "./click-buffer.js";

export class InMemoryClickBuffer implements ClickBuffer {
  #buffer: ClickRow[] = [];
  #inflight: ClickRow[] = [];
  #dropped = 0;
  readonly #maxLength: number;

  public constructor(maxLength = 1000) {
    this.#maxLength = maxLength;
  }

  public push(row: ClickRow): Promise<PushOutcome> {
    if (this.#buffer.length >= this.#maxLength) {
      this.#dropped += 1;
      return Promise.resolve("dropped");
    }
    this.#buffer.push(row);
    return Promise.resolve("buffered");
  }

  public drain(max: number): Promise<ClickBatch> {
    if (this.#inflight.length > 0) {
      return Promise.resolve({ rows: [...this.#inflight], discarded: 0 });
    }
    this.#inflight = this.#buffer.splice(0, max);
    return Promise.resolve({ rows: [...this.#inflight], discarded: 0 });
  }

  public ack(): Promise<void> {
    this.#inflight = [];
    return Promise.resolve();
  }

  public depth(): Promise<number> {
    return Promise.resolve(this.#buffer.length);
  }

  public droppedTotal(): Promise<number> {
    return Promise.resolve(this.#dropped);
  }

  /** Test-only: the batch a crashed flusher would leave behind. */
  public get inflight(): readonly ClickRow[] {
    return this.#inflight;
  }
}
