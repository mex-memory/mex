// The deterministic knowledge corpus for the delivery gate: facts about Hono
// at T0, each with the check MEX records for it (the "MEX side") and an
// independent truth function over the file text at a checkpoint (the "answer
// key"). Nothing here comes from a model: the claims and their truth
// functions are hand-written, and the checks are recorded by the real
// evaluator at T0. This corpus stands in for one written by setup and
// capture until those can produce it; its manifest says so.
//
// A truth function gets `show(path)`, the file's text at the checkpoint or
// null, and answers whether the claim still holds there. It must hold at T0.

export const SUBJECT = Object.freeze({
  repo: 'https://github.com/honojs/hono.git',
  t0: 'e3bf8c8913a707e49f374575bdf6c88f0ec7e3f6',
  t1: '52febbcc30bc509d5e4987577e63906fe08fc471',
});

const json = (show, file) => {
  const text = show(file);
  if (text === null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};
const pointer = (doc, ptr) => ptr.split('/').slice(1)
  .map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))
  .reduce((v, k) => (v !== undefined && v !== null && typeof v === 'object' ? v[k] : undefined), doc);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// key claims: the value at a JSON pointer is what it was at T0.
function key(id, file, ptr, value, oneLine) {
  return {
    id, category: 'config', oneLine, file,
    check: { kind: 'key', role: 'complete', target: { file, pointer: ptr } },
    truth: show => same(pointer(json(show, file), ptr), value),
  };
}

// value claims: a literal in source, read here with a plain regular
// expression (not the evaluator's parser).
const quoted = s => [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]);
function literal(id, file, symbol, re, expected, oneLine) {
  return {
    id, category: 'structure', oneLine, file,
    check: { kind: 'value', role: 'complete', target: { file, symbol } },
    truth: show => {
      const text = show(file);
      const m = text && text.match(re);
      if (!m) return false;
      const got = Array.isArray(expected) ? quoted(m[1]) : quoted(m[1])[0];
      return same(got, expected);
    },
  };
}

// behaviour claims: a symbol's fingerprint supports the claim (any change to
// the code sends it to review); the truth function tests the claim's meaning.
function behaviour(id, file, symbol, oneLine, holds) {
  return {
    id, category: 'behaviour', oneLine, file,
    check: { kind: 'symbol', role: 'supporting', target: { file, symbol } },
    truth: show => {
      const text = show(file);
      return text !== null && holds(text);
    },
  };
}

const pkg = 'package.json';
export const CLAIMS = Object.freeze([
  key('k01', pkg, '/version', '4.9.9', 'The package version is 4.9.9.'),
  key('k02', pkg, '/scripts/test', 'tsc --noEmit && vitest --run', '`npm test` type-checks with `tsc --noEmit` and then runs vitest once.'),
  key('k03', pkg, '/scripts/test:node', 'vitest --run --project node', '`test:node` runs only the vitest project named node.'),
  key('k04', pkg, '/scripts/test:workerd', 'vitest --run --project workerd', '`test:workerd` runs only the vitest project named workerd.'),
  key('k05', pkg, '/scripts/test:lambda', 'vitest --run --project lambda', '`test:lambda` runs only the vitest project named lambda.'),
  key('k06', pkg, '/scripts/lint', 'eslint src runtime-tests build perf-measures benchmarks', 'Lint covers src, runtime-tests, build, perf-measures and benchmarks.'),
  key('k07', pkg, '/scripts/coverage', 'vitest --run --coverage', 'Coverage comes from `vitest --run --coverage`.'),
  key('k08', pkg, '/scripts/release', 'np', 'Releases are cut with `np`, which also publishes.'),
  key('k09', pkg, '/scripts/prerelease', 'bun test:deno && bun run build', 'Before a release the Deno tests run and the package is built.'),
  key('k10', pkg, '/scripts/postbuild', 'publint', 'Every build is followed by publint.'),
  key('k11', pkg, '/scripts/remove-dist', 'rm -rf dist', '`remove-dist` deletes the dist folder.'),
  key('k12', pkg, '/engines/node', '>=16.9.0', 'The package supports Node 16.9.0 and later.'),
  key('k13', pkg, '/devDependencies/typescript', '^5.9.2', 'TypeScript is pinned at ^5.9.2.'),
  key('k14', pkg, '/devDependencies/vitest', '^3.2.4', 'Tests run on vitest ^3.2.4.'),
  key('k15', pkg, '/devDependencies/eslint', '^9.10.0', 'Lint runs on eslint ^9.10.0.'),
  key('k16', pkg, '/devDependencies/prettier', '^2.6.2', 'Formatting uses prettier ^2.6.2.'),
  key('k17', pkg, '/devDependencies/wrangler', '4.12.0', 'The workerd tests use wrangler 4.12.0.'),
  key('k18', pkg, '/devDependencies/jsdom', '22.1.0', 'DOM tests use jsdom 22.1.0.'),
  key('k19', pkg, '/devDependencies/np', '10.2.0', 'Releases use np 10.2.0.'),
  key('k20', pkg, '/devDependencies/zod', '^3.23.8', 'Validator tests use zod ^3.23.8.'),

  literal('v01', 'src/router.ts', 'METHODS', /export const METHODS = \[([^\]]*)\]/, ['get', 'post', 'put', 'delete', 'options', 'patch'], 'The router knows the methods get, post, put, delete, options and patch.'),
  literal('v02', 'src/router.ts', 'METHOD_NAME_ALL', /export const METHOD_NAME_ALL = ('[^']*')/, 'ALL', "The method name for all methods is 'ALL'."),
  literal('v03', 'src/middleware/compress/index.ts', 'ENCODING_TYPES', /const ENCODING_TYPES = \[([^\]]*)\]/, ['gzip', 'deflate'], 'compress offers gzip and deflate, in that order.'),
  literal('v04', 'src/middleware/etag/index.ts', 'RETAINED_304_HEADERS', /export const RETAINED_304_HEADERS = \[([^\]]*)\]/, ['cache-control', 'content-location', 'date', 'etag', 'expires', 'vary'], 'A 304 from etag keeps cache-control, content-location, date, etag, expires and vary.'),
  literal('v05', 'src/middleware/body-limit/index.ts', 'ERROR_MESSAGE', /const ERROR_MESSAGE = ('[^']*')/, 'Payload Too Large', "bodyLimit's default error body is 'Payload Too Large'."),
  literal('v06', 'src/utils/mime.ts', '_baseMimes.csv', /^\s*csv: ('[^']*')/m, 'text/csv', 'CSV files are served as text/csv.'),
  literal('v07', 'src/utils/mime.ts', '_baseMimes.mjs', /^\s*mjs: ('[^']*')/m, 'text/javascript', '.mjs files are served as text/javascript.'),
  literal('v08', 'src/utils/mime.ts', '_baseMimes.svg', /^\s*svg: ('[^']*')/m, 'image/svg+xml', 'SVG files are served as image/svg+xml.'),
  literal('v09', 'src/utils/mime.ts', '_baseMimes.json', /^\s*json: ('[^']*')/m, 'application/json', 'JSON files are served as application/json.'),
  literal('v10', 'src/utils/mime.ts', '_baseMimes.png', /^\s*png: ('[^']*')/m, 'image/png', 'PNG files are served as image/png.'),
  literal('v11', 'src/utils/mime.ts', '_baseMimes.wasm', /^\s*wasm: ('[^']*')/m, 'application/wasm', 'WebAssembly files are served as application/wasm.'),
  literal('v12', 'src/utils/mime.ts', '_baseMimes.avif', /^\s*avif: ('[^']*')/m, 'image/avif', 'AVIF images are served as image/avif.'),

  behaviour('b01', 'src/request.ts', 'HonoRequest.parseBody', 'Repeated parseBody() calls return the same parsed object, cached on the request.', t => /bodyCache\.parsedBody/.test(t)),
  behaviour('b02', 'src/utils/url.ts', 'getPath', 'getPath decodes percent-encoded paths with tryDecodeURI.', t => /export const getPath/.test(t) && /tryDecodeURI/.test(t)),
  behaviour('b03', 'src/middleware/basic-auth/index.ts', 'basicAuth', 'basicAuth compares credentials with timingSafeEqual.', t => /timingSafeEqual/.test(t)),
  behaviour('b04', 'src/middleware/trailing-slash/index.ts', 'trimTrailingSlash', 'trimTrailingSlash redirects GET and HEAD only after a 404; it has no option to redirect every request.', t => /c\.res\.status === 404/.test(t) && /'GET' \|\| c\.req\.method === 'HEAD'/.test(t) && !/alwaysRedirect/.test(t)),
  behaviour('b05', 'src/middleware/cors/index.ts', 'cors', "cors adds 'Vary: Origin' when the allowed origin is not '*'.", t => /['"]Vary['"],\s*['"]Origin['"]/.test(t)),
  behaviour('b06', 'src/middleware/etag/index.ts', 'etag', 'etag emits weak validators (W/) when the weak option is on.', t => /W\//.test(t) && /weak/.test(t)),
  behaviour('b07', 'src/middleware/csrf/index.ts', 'csrf', 'csrf also accepts requests by their Sec-Fetch-Site header.', t => /secFetchSite/.test(t)),
  behaviour('b08', 'src/context.ts', 'Context', "c.json() answers with content-type 'application/json'.", t => /application\/json/.test(t)),
  behaviour('b09', 'src/validator/validator.ts', 'validator', "The json validator answers 400 'Malformed JSON in request body' for bad JSON.", t => /Malformed JSON in request body/.test(t) && /400/.test(t)),
  behaviour('b10', 'src/middleware/body-limit/index.ts', 'bodyLimit', 'bodyLimit answers 413 when the body is over the limit.', t => /status: 413/.test(t)),
  behaviour('b11', 'src/router/smart-router/router.ts', 'SmartRouter', 'SmartRouter falls through to the next router on UnsupportedPathError.', t => /UnsupportedPathError/.test(t)),
  behaviour('b12', 'src/middleware/compress/index.ts', 'compress', 'compress skips responses smaller than its 1024-byte threshold.', t => /1024/.test(t)),
  behaviour('b13', 'src/utils/cookie.ts', 'parse', 'Cookie names are checked against validCookieNameRegEx when parsing.', t => /validCookieNameRegEx/.test(t)),
  behaviour('b14', 'src/hono-base.ts', 'Hono.onError', 'Errors without a handler go through the app errorHandler.', t => /errorHandler/.test(t)),
]);

// ── The other check kinds (corpus revision eight-kinds-v1) ──
//
// Truth functions here also get `list(prefix)`: every path under prefix at
// the checkpoint. Scoped claims (patterns, relations) are read over all the
// files in scope, as the claim says, never through MEX's own index.

// command claims: the script a command runs is still defined.
function command(id, script, oneLine) {
  return {
    id, category: 'command', oneLine, file: pkg,
    check: { kind: 'command', role: 'complete', target: { run: `npm run ${script}`, file: pkg, pointer: `/scripts/${script.replaceAll('~', '~0').replaceAll('/', '~1')}` } },
    truth: show => typeof json(show, pkg)?.scripts?.[script] === 'string',
  };
}

/** The text under a Markdown heading (by its text), up to the next heading of the same or a higher level. */
function sectionText(text, heading) {
  if (text === null) return null;
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#{1,6} /.test(l) && l.replace(/^#+ /, '').trim() === heading);
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// section claims: what a document section says. The section's hash supports
// the claim without pinning it (a reworded section can still say it), so the
// check is supporting, as a note records it.
function section(id, file, heading, oneLine, holds) {
  return {
    id, category: 'docs', oneLine, file,
    check: { kind: 'section', role: 'supporting', target: { file, heading } },
    truth: show => { const t = sectionText(show(file), heading); return t !== null && holds(t); },
  };
}

// source claims: what a whole file does. Supporting, like a section's hash.
function source(id, file, oneLine, holds) {
  return {
    id, category: 'behaviour', oneLine, file,
    check: { kind: 'source', role: 'supporting', target: { file } },
    truth: show => { const t = show(file); return t !== null && holds(t); },
  };
}

const occurrences = (text, literal) => text.split(literal).length - 1;

// pattern claims: how many times a literal appears in the files of a folder.
function pattern(id, folder, literal, count, oneLine) {
  return {
    id, category: 'convention', oneLine, file: `${folder}/**`,
    check: { kind: 'pattern', role: 'complete', target: { scope: `${folder}/**`, pattern: literal } },
    truth: (show, list) => list(`${folder}/`).reduce((n, f) => n + occurrences(show(f) ?? '', literal), 0) === count,
  };
}

/**
 * Relative imports from code under `from` that resolve into `to` (a folder,
 * or a file). An import resolves as a bundler resolves it: to `x.ts` or
 * `x.tsx` when that file exists, else to the folder's index file.
 */
function importsInto(show, list, from, to) {
  const exists = path => list(path).includes(path);
  const resolveTo = stem => ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => stem + ext).find(exists);
  let n = 0;
  for (const f of list(`${from}/`).filter(f => /\.(ts|tsx)$/.test(f))) {
    for (const m of (show(f) ?? '').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const parts = f.split('/').slice(0, -1);
      for (const p of m[1].split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
      const target = resolveTo(parts.join('/').replace(/\.js$/, ''));
      if (target && (target === to || target.startsWith(`${to}/`))) n++;
    }
  }
  return n;
}

// relation claims: a boundary between parts of the code, as an import or a
// call count. A call needs an import, so no import proves no call.
function boundary(id, query, from, to, oneLine) {
  const toScope = /\.tsx?$/.test(to) ? to : `${to}/**`;
  return {
    id, category: 'architecture', oneLine, file: `${from}/**`,
    check: { kind: 'relation', role: 'complete', target: { query, from: `${from}/**`, to: toScope } },
    truth: (show, list) => importsInto(show, list, from, to) === 0,
  };
}

export const KIND_CLAIMS = Object.freeze([
  command('c01', 'build', '`npm run build` builds the package.'),
  command('c02', 'lint:fix', '`npm run lint:fix` fixes lint errors in place.'),
  command('c03', 'test:deno', '`npm run test:deno` runs the Deno tests.'),
  command('c04', 'format:fix', '`npm run format:fix` formats the code in place.'),

  section('s01', 'docs/CONTRIBUTING.md', 'Local Development', 'Local development runs in the devcontainer, started with `docker compose up -d --build`.', t => /docker compose up -d --build/.test(t)),
  section('s02', 'docs/CONTRIBUTING.md', 'Third-party middleware', 'Third-party middleware may depend on other libraries or work only in some environments.', t => /depend on other libraries/.test(t)),
  section('s03', 'docs/MIGRATION.md', 'Validator is changed', 'The migration guide explains the v3 validator change under "Validator is changed".', t => /validator/i.test(t)),
  section('s04', 'docs/MIGRATION.md', 'StaticRouter is obsolete', 'The migration guide says StaticRouter is obsolete from v3.', t => /StaticRouter/.test(t)),
  section('s05', 'docs/CONTRIBUTING.md', 'Installing dependencies', 'Contributors install dependencies with bun.', t => /bun/.test(t)),

  source('f01', 'src/utils/compress.ts', 'JSON responses count as compressible.', t => /application\\\/\(\?:javascript\|json/.test(t)),
  source('f02', 'src/utils/compress.ts', 'MessagePack responses are not treated as compressible.', t => !/msgpack/.test(t)),
  source('f03', 'src/utils/filepath.ts', 'getFilePath turns only the first backslash into a slash.', t => /replace\(\/\\\\\/, '\/'\)/.test(t)),
  source('f04', 'src/utils/constants.ts', 'The composed-handler marker is a shared constant.', t => /COMPOSED_HANDLER/.test(t)),
  source('f05', 'src/http-exception.ts', 'HTTPException can carry its own Response.', t => /class HTTPException/.test(t) && /res\?: Response/.test(t)),

  pattern('p01', 'src', 'console.log(', 22, '`src` has 22 `console.log(` calls.'),
  pattern('p02', 'src/middleware', 'new HTTPException(', 14, 'Middleware throws `new HTTPException(` in 14 places.'),
  pattern('p03', 'src', 'process.env', 1, '`process.env` is read in one place in `src`.'),
  pattern('p04', 'src/adapter', 'Deno.', 6, 'The adapters touch the `Deno.` global in 6 places.'),
  pattern('p05', 'src', '@ts-ignore', 24, '`src` has 24 `@ts-ignore` comments.'),

  boundary('r01', 'imports', 'src/utils', 'src/middleware', '`src/utils` never imports `src/middleware`.'),
  boundary('r02', 'imports', 'src/router', 'src/middleware', '`src/router` never imports `src/middleware`.'),
  boundary('r03', 'imports', 'src/client', 'src/router', '`src/client` never imports `src/router`.'),
  boundary('r04', 'imports', 'src/validator', 'src/request.ts', '`src/validator` never imports `src/request.ts`.'),
  boundary('r05', 'imports', 'src/helper', 'src/http-exception.ts', '`src/helper` never imports `src/http-exception.ts`.'),
  boundary('r06', 'imports', 'src/jsx', 'src/adapter', '`src/jsx` never imports `src/adapter`.'),
  boundary('r07', 'calls', 'src/utils', 'src/middleware', 'Nothing in `src/utils` calls into `src/middleware`.'),
  boundary('r08', 'calls', 'src/router', 'src/helper', 'Nothing in `src/router` calls into `src/helper`.'),
  boundary('r09', 'calls', 'src/jsx', 'src/adapter', 'Nothing in `src/jsx` calls into `src/adapter`.'),
]);
