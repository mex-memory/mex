// Captured files on disk instead of in memory.
//
// The finishing pass can only resolve a file's references once every file is
// captured, so a whole repository's captures used to sit in memory together:
// about 1 GB of Node heap on novu. A large build writes each capture to a
// private spool file as it is made and reads it back once, in the finishing
// pass; only the small location and name maps stay in memory.

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

/** The part of Map the extraction pass uses for its captures. */
export interface CaptureMap<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): unknown;
  delete(key: string): boolean;
  readonly size: number;
  dispose?(): void;
}

export class SpooledCaptures<T> implements CaptureMap<T> {
  private readonly directory: string;
  private readonly fd: number;
  private readonly index = new Map<string, { offset: number; length: number }>();
  private end = 0;
  /** Bytes written, for the phase report. */
  written = 0;

  constructor(parent = tmpdir()) {
    this.directory = mkdtempSync(join(parent, "mex-captures-"));
    this.fd = openSync(join(this.directory, "captures.bin"), "w+");
  }

  get size(): number {
    return this.index.size;
  }

  set(key: string, value: T): this {
    const bytes = serialize(value);
    let done = 0;
    while (done < bytes.length) done += writeSync(this.fd, bytes, done, bytes.length - done, this.end + done);
    this.index.set(key, { offset: this.end, length: bytes.length });
    this.end += bytes.length;
    this.written += bytes.length;
    return this;
  }

  get(key: string): T | undefined {
    const at = this.index.get(key);
    if (!at) return undefined;
    const bytes = Buffer.allocUnsafe(at.length);
    let done = 0;
    while (done < at.length) {
      const read = readSync(this.fd, bytes, done, at.length - done, at.offset + done);
      if (read === 0) throw new Error("The capture spool ended early.");
      done += read;
    }
    return deserialize(bytes) as T;
  }

  delete(key: string): boolean {
    // The bytes stay in the file until the spool is disposed.
    return this.index.delete(key);
  }

  dispose(): void {
    try { closeSync(this.fd); } catch { /* already closed */ }
    rmSync(this.directory, { recursive: true, force: true });
  }
}
