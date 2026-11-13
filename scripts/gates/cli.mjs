import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { selectRelease } from './catalog.mjs';
import { runGates, releaseReady, table } from './runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--release': 'release', '--report': 'report' }[args[index]];
    if (!key || !args[index + 1] || result[key]) throw new Error('Use --release beta.1|beta.2|final and --report <path>');
    result[key] = args[index + 1];
  }
  return result;
}

try {
  const opts = options(process.argv.slice(2));
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const release = selectRelease(opts.release, process.env, version);
  const report = await runGates({ root, release });
  if (opts.report) {
    const path = resolve(opts.report), temporary = `${path}.${randomUUID()}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
  console.log(table(report));
  process.exitCode = releaseReady(report) ? 0 : 1;
} catch {
  // Diagnostics from a private corpus or child process must never reach public
  // CI artifacts. The report's reason catalog is the supported public output.
  console.error('Release gate runner failed: check arguments, tag/version, tools, and checkout identity.');
  process.exitCode = 1;
}
