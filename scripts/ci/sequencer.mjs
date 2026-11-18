import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';

// Hash buckets keep membership stable when other files are added. The two
// buckets separate the longest setup and authoring contracts in CI's measured
// suite, without a duration manifest that would need continual maintenance.
export function shardForPath(path, count) {
  return createHash('sha256').update(path.replaceAll('\\', '/')).digest().readUInt32BE(0) % count + 1;
}

export default class CISequencer extends BaseSequencer {
  async shard(files) {
    const { root, shard: { index, count } } = this.ctx.config;
    return files.filter((spec) => shardForPath(relative(root, spec.moduleId), count) === index);
  }
}
