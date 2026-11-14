// The knowledge bench gate's live adapter. It rebuilds the deterministic Hono
// corpus from a clone of the public subject, checks its digest against the
// one pinned here (a corpus change is a reviewed code change), builds the hook
// binary, and runs the bench through the real evaluator and delivery code.
// Only the reduced pass/fail result leaves this function.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus } from '../knowledge-bench/build-corpus.mjs';
import { SUBJECT } from '../knowledge-bench/claims.mjs';
import { runBench } from '../knowledge-bench/run.mjs';
import { knowledgeEvidence } from './knowledge-score.mjs';

export const KNOWLEDGE_CORPUS_SHA256 = '6d693e9985c432356f6f0f1bf5319bc87559bece082cbb40314ce6637c69b687';

const unavailable = { status: 'unavailable', reason: 'tool-unavailable' };

export async function knowledgeBench({ root, cache = join(tmpdir(), 'mex-knowledge-bench') }) {
  const quiet = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 };
  if (!existsSync(join(root, 'dist', 'cli.js'))) return unavailable;
  mkdirSync(cache, { recursive: true });
  const subject = join(cache, 'subject');
  try {
    if (!existsSync(join(subject, '.git'))) execFileSync('git', ['clone', '--quiet', '--no-checkout', SUBJECT.repo, subject], quiet);
    execFileSync('git', ['-C', subject, 'cat-file', '-e', `${SUBJECT.t1}^{commit}`], quiet);
  } catch {
    return unavailable;
  }
  const binary = join(cache, process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook');
  try {
    execFileSync('go', ['build', '-trimpath', '-o', binary, './cmd/mex-hook'], { ...quiet, cwd: join(root, 'native'), env: { ...process.env, CGO_ENABLED: '0' } });
  } catch {
    return unavailable;
  }
  try {
    const built = buildCorpus(subject);
    if (built.manifest.dataset_sha256 !== KNOWLEDGE_CORPUS_SHA256) return { status: 'fail', reason: 'invalid-evidence' };
    const corpusDir = join(cache, 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    for (const [name, text] of Object.entries(built.files)) writeFileSync(join(corpusDir, name), text);
    writeFileSync(join(corpusDir, 'manifest.json'), JSON.stringify(built.manifest, null, 1) + '\n');
    const work = join(cache, 'run');
    const { corpus, observed, expected } = runBench({ subject, corpusDir, binary, work, cli: join(root, 'dist', 'cli.js') });
    return knowledgeEvidence(corpus, observed, expected);
  } catch {
    return { status: 'fail', reason: 'invalid-evidence' };
  }
}
