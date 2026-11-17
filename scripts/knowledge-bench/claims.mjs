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
