import type { RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";

type Opener = (location: LocationOptions) => RecordReader | undefined;

/** Treat a missing store as empty, while letting an unreadable store surface as a request error. */
export function readStore<T>(open: Opener, location: LocationOptions, read: (reader: RecordReader | undefined) => T): T {
  const reader = open(location);
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    return read(reader);
  } finally { reader?.close(); }
}

export function boundedSetting(reader: RecordReader, scope: string, key: string, maxBytes: number): string | undefined {
  return reader.get<{ value: string }>(
    "SELECT value FROM settings WHERE scope=? AND key=? AND length(CAST(value AS BLOB))<=?", scope, key, maxBytes,
  )?.value;
}
