const ACTIVE_MS = 25_000;
const REFRESH_MS = 10_000;
const DEADLINE_MS = 45_000;

function readIssue(error: unknown, fallback: string): string {
  return error instanceof Error && /^(?:record|hooks)\.db schema version \d+ is newer than supported version \d+;/u.test(error.message)
    ? error.message : fallback;
}

/** An authenticated GET schedules a sample and immediately returns the last completed one. */
export class ControlSnapshot<T extends { issue?: string }> {
  #data: T | undefined;
  #issue: string | undefined;
  #encoded: string | undefined;
  #updatingSince: string | undefined;
  #activity = -Infinity;
  #next = 0;
  #timer: NodeJS.Timeout | undefined;
  #reading: AbortController | undefined;
  #visited = false;
  #closed = false;
  #version = 0;

  constructor(
    private readonly now: () => number,
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly unavailable: string,
  ) {}

  get version() { return this.#version; }

  get(): Partial<T> & { updatingSince?: string; issue?: string } {
    this.#visited = true;
    this.touch();
    const data: Partial<T> = this.#data ?? {};
    return Object.assign({}, data, { updatingSince: this.#updatingSince, issue: this.#issue ?? data.issue });
  }

  update(edit: (data: T) => T) {
    if (!this.#data) return;
    this.#store(edit(this.#data));
  }

  replace(data: T) {
    this.#reading?.abort();
    this.#issue = this.#updatingSince = undefined;
    this.#store(data);
  }

  touch() {
    if (!this.#visited || this.#closed) return;
    this.#activity = performance.now();
    this.#schedule();
  }

  refresh() {
    if (!this.#visited || this.#closed) return;
    this.#next = 0;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#reading?.abort();
    this.#updatingSince ??= new Date(this.now()).toISOString();
    this.touch();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#reading?.abort();
  }

  #store(data: T) {
    this.#data = data;
    this.#encoded = JSON.stringify(data);
    this.#version++;
  }

  #schedule() {
    if (this.#closed || this.#timer || this.#reading) return;
    const now = performance.now(), wait = Math.max(0, this.#next - now);
    if (now + wait - this.#activity >= ACTIVE_MS) return;
    if (wait === 0) this.#updatingSince ??= new Date(this.now()).toISOString();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (performance.now() - this.#activity < ACTIVE_MS) void this.#sample();
    }, wait);
    this.#timer.unref();
  }

  async #sample() {
    const reading = this.#reading = new AbortController();
    const signal = AbortSignal.any([reading.signal, AbortSignal.timeout(DEADLINE_MS)]);
    const updating = this.#updatingSince;
    this.#updatingSince ??= new Date(this.now()).toISOString();
    const wasUnavailable = this.#issue !== undefined;
    this.#next = performance.now() + REFRESH_MS;
    // Stop outstanding Git probes and scans when the last tab stops polling.
    const check = setInterval(() => {
      if (performance.now() - this.#activity >= ACTIVE_MS) reading.abort();
    }, 2_000);
    check.unref();
    try {
      const next = await this.read(signal);
      signal.throwIfAborted();
      const encoded = JSON.stringify(next);
      if (encoded !== this.#encoded || wasUnavailable || updating) this.#version++;
      this.#encoded = encoded;
      this.#data = next;
      this.#issue = undefined;
    } catch (error) {
      if (!reading.signal.aborted) {
        this.#issue = readIssue(error, this.unavailable);
        this.#version++;
      }
    } finally {
      clearInterval(check);
      this.#reading = undefined;
      if (this.#next > 0) this.#updatingSince = undefined;
      this.#schedule();
    }
  }
}
