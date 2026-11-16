#!/usr/bin/env node
// Default is a $0 plan. --run requires the separately approved exact fingerprint.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { build } from 'tsup';
import { buildCorpus, REVIEW } from './build-corpus.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function argumentsFor(args) {
  const result = {};
  for (let n = 0; n < args.length; n++) {
    const key = args[n];
    if (!['--subject', '--out', '--run', '--approve-plan', '--work', '--binary', '--checks-from', '--rescore'].includes(key) || key in result) throw new Error('Unknown or duplicate argument');
    result[key] = key === '--run' ? true : args[++n];
    if (!result[key]) throw new Error(`Missing value for ${key}`);
  }
  if (!result['--subject']) throw new Error('Use --subject <pinned corpus clone> [--out <new plan.json>]; paid execution additionally requires --run --approve-plan <hash> --work <new directory> --binary <mex-hook>');
  return result;
}
try {
  const args = argumentsFor(process.argv.slice(2));
  // Product helpers resolve package/assets beside dist. Never clean that shared output.
  const out = join(root, 'dist');
  await build({ config: false, entry: { 'oss68-evaluation': join(root, 'scripts/knowledge-bench/model-runtime.ts') }, outDir: out,
    format: ['esm'], platform: 'node', target: 'node22', clean: false, splitting: false, dts: false,
    noExternal: ['@mex/hub-contracts', 'zod'], silent: true,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const runtime = await import(pathToFileURL(join(out, 'oss68-evaluation.js')).href);
  const subject = resolve(args['--subject']);
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_NAMESPACE','GIT_PREFIX']) delete process.env[key];
  const legacy = buildCorpus(subject), built = buildCorpus(subject, { revision: REVIEW.revision });
  if (legacy.manifest.dataset_sha256 !== REVIEW.parent_dataset_sha256 || built.manifest.dataset_sha256 !== REVIEW.reviewed_dataset_sha256) throw new Error('The reviewed corpus changed');
  if (args['--rescore']) {
    if (!args['--out'] || ['--run','--approve-plan','--work','--binary','--checks-from'].some(k => args[k])) throw new Error('Rescoring requires --out and forbids execution/check-replay flags');
    const audit = runtime.rescoreReport(resolve(args['--rescore']), legacy.corpus, built.corpus, subject);
    const file = resolve(args['--out']); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ kind: audit.kind, model_calls: 0, checkpoints: audit.checkpoints.map(cp => ({ id: cp.id, score: cp.label_corrected_score })) }));
    process.exit(0);
  }
  const candidate = runtime.git(root, 'rev-parse', 'HEAD').trim();
  const fixed = args['--checks-from'] ? runtime.loadFixedChecks(resolve(args['--checks-from']), built.corpus, subject, legacy.corpus) : undefined;
  const plan = runtime.makePlan(built.corpus, subject, candidate, fixed);
  if (!args['--run']) {
    if (args['--approve-plan'] || args['--work'] || args['--binary']) throw new Error('Paid-only flags require --run');
    if (args['--out']) {
      const file = resolve(args['--out']); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({ paid_calls: 0, mode: plan.mode, model: plan.model, claims: built.corpus.claims.length,
      checkpoints: plan.checkpoints.map(({ id, true: kept, stale }) => ({ id, true: kept, stale })),
      check_writer_calls: plan.check_writer_calls, check_repair_calls_max: plan.check_repair_calls_max, judge_calls_max: plan.judge_calls_max, max_calls: plan.max_calls,
      privacy_withheld: plan.privacy_withheld, regenerated_check_claims: fixed?.regenerate ?? [], reused_checks: fixed?.results.length ?? 0,
      conservative_api_equivalent_usd: plan.conservative_api_equivalent_usd,
      approval_usd: plan.approval_usd, approval_hash: plan.approval_hash, price_source: plan.price_source }, null, 2));
  } else {
    if (process.env.CI || process.env.MEX_SETUP_BACKGROUND_AGENTS === '0' || process.env.MEX_OFF === '1') throw new Error('Paid evaluation is disabled in CI, test mode or MEX_OFF');
    if (args['--approve-plan'] !== plan.approval_hash) throw new Error('Approve the exact current plan before running');
    if (runtime.git(root, 'status', '--porcelain').trim()) throw new Error('Paid evaluation requires a clean committed candidate');
    if (!args['--work'] || !args['--binary'] || !existsSync(args['--binary'])) throw new Error('Use a new --work directory and an existing --binary');
    const model = request => runtime.runModel({ ...request, role: 'cheap',
      models: { ...runtime.DEFAULT_MODELS, claude: { ...runtime.DEFAULT_MODELS.claude, cheap: runtime.MODEL } },
      __internal: { spawn: (command, argv, options) => {
        if (command !== 'claude') throw new Error('The approved run uses only the pinned cheap model');
        return crossSpawn(command, [...argv, '--max-budget-usd', '0.05', '--max-turns', '1', '--fallback-model', runtime.MODEL], {
          ...options, env: { ...options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(runtime.OUTPUT_TOKENS), CLAUDE_CODE_MAX_RETRIES: '0' },
        });
      } },
    });
    const report = await runtime.runEvaluation({ plan, approvalHash: args['--approve-plan'], corpus: built.corpus, subject,
      fixed, work: resolve(args['--work']), binary: resolve(args['--binary']), model,
      refreshIndex: cwd => execFileSync(process.execPath, [join(root, 'dist/cli.js'), 'index', '--json'], { cwd, env: { ...process.env, MEX_BACKGROUND: '0' }, timeout: 120_000, stdio: ['ignore','pipe','pipe'], maxBuffer: 2 << 20 }),
    });
    console.log(JSON.stringify({ complete: report.complete, calls: report.ledger.length, checkpoints: report.checkpoints,
      charged_api_equivalent_usd: report.charged_api_equivalent_usd }, null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Evaluation preparation failed'); process.exitCode = 1; }
