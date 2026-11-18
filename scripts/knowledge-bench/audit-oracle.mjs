// Independent audit: actual middleware observations for behavior; plain JSON /
// declaration reads for configuration. Never invokes the native evaluator or a model.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const literal=(text,name)=>text.match(new RegExp(`(?:export )?const ${name} = (\\[[^\\]]*\\]|'[^']*')`))?.[1];
const strings=text=>[...(text??'').matchAll(/'([^']*)'/g)].map(m=>m[1]);
const at=(value,pointer)=>pointer.split('/').slice(1).reduce((v,k)=>v?.[k],value);
export function observedTruth(f,sources,seedSources) {
  const required={b01:['status','same'],b02:['path'],b03:['calls_timing_safe_equal'],b04:['get_default_ok.status','head_default_ok.status','get_default_missing.status','head_default_missing.status','option_ok.status'],b05:['vary'],v04:['status','headers.etag'],b06:['generated.headers.etag','preset.headers.etag'],b07:['status'],b08:['content_type'],b09:['status','body'],b10:['length.status','length.body','stream.status','override.status'],b11:['fallback_hits','matched'],b12:['small.encoding','small_with_length.encoding','large.encoding'],b13:['parse_uses_strict','parse_uses_relaxed','parsed','serializer_rejects_colon'],mime:['csv','mjs','svg','json','png','wasm','avif'],b14:['status','handler_hits']};
  for(const [group,paths] of Object.entries(required)) for(const path of paths) if(path.split('.').reduce((v,key)=>v?.[key],f[group])===undefined) throw new Error(`Incomplete behavior probe: ${group}.${path}`);
  if(Object.values(f).some(v=>!v || 'error' in v)) throw new Error('Behavior probe unavailable');
  const truth={}, pkg=JSON.parse(sources['package.json']), seed=JSON.parse(seedSources['package.json']);
  const pointers=['/version',...['test','test:node','test:workerd','test:lambda','lint','coverage','release','prerelease','postbuild','remove-dist'].map(k=>`/scripts/${k}`),'/engines/node',...['typescript','vitest','eslint','prettier','wrangler','jsdom','np','zod'].map(k=>`/devDependencies/${k}`)];
  pointers.forEach((pointer,i)=>truth[`k${String(i+1).padStart(2,'0')}`]=at(seed,pointer)!==undefined && equal(at(pkg,pointer),at(seed,pointer)));
  truth.v01=equal(strings(literal(sources['src/router.ts'],'METHODS')),['get','post','put','delete','options','patch']);
  truth.v02=literal(sources['src/router.ts'],'METHOD_NAME_ALL')==="'ALL'";
  truth.v03=equal(strings(literal(sources['src/middleware/compress/index.ts'],'ENCODING_TYPES')),['gzip','deflate']);
  const expectedHeaders={'cache-control':'max-age=60','content-location':'/item',date:'Mon, 16 Nov 2026 00:00:00 GMT',expires:'Tue, 17 Nov 2026 00:00:00 GMT',vary:'Accept-Language'};
  truth.v04=f.v04?.status===304 && !!f.v04?.headers.etag && Object.entries(expectedHeaders).every(([k,v])=>f.v04?.headers[k]===v);
  truth.v05=f.b10?.length.body==='Payload Too Large';
  for(const [i,ext,expected] of [[6,'csv','text/csv'],[7,'mjs','text/javascript'],[8,'svg','image/svg+xml'],[9,'json','application/json'],[10,'png','image/png'],[11,'wasm','application/wasm'],[12,'avif','image/avif']]) {
    // Exact mapping declaration; getMimeType() may independently append a charset.
    truth[`v${String(i).padStart(2,'0')}`]=sources['src/utils/mime.ts'].match(new RegExp(`^\\s*${ext}: '([^']*)'`,'m'))?.[1]===expected;
  }
  truth.b01=f.b01?.status===200 && f.b01.same===true;
  truth.b02=f.b02?.path==='/あ';
  truth.b03=f.b03?.calls_timing_safe_equal===true;
  truth.b04=['get','head'].every(method=>f.b04?.[`${method}_default_ok`].status===200 && f.b04?.[`${method}_default_missing`].status===301) && f.b04?.option_ok.status===200;
  truth.b05=f.b05?.vary?.split(/,\s*/).includes('Origin')===true;
  truth.b06=f.b06?.generated.headers.etag?.startsWith('W/')===true;
  truth.b07=f.b07?.status===200;
  truth.b08=f.b08?.content_type?.split(';')[0]==='application/json';
  truth.b09=f.b09?.status===400 && f.b09.body==='Malformed JSON in request body';
  truth.b10=f.b10?.length.status===413;
  truth.b11=f.b11?.fallback_hits===1 && f.b11.matched===true;
  truth.b12=f.b12?.small_with_length.encoding===null;
  truth.b13=f.b13?.parse_uses_strict===true && !('paraglide:lang' in f.b13.parsed);
  truth.b14=f.b14?.status===418 && f.b14.handler_hits===1;
  return truth;
}
export function verifyTruth(truth,corpus,checkpoint) {
  const labels=corpus.labels.filter(l=>l.checkpoint===checkpoint);
  if(Object.keys(truth).length!==corpus.claims.length || new Set(corpus.claims.map(c=>c.id)).size!==corpus.claims.length || corpus.claims.some(c=>typeof truth[c.id]!=='boolean') || labels.length!==corpus.claims.length || new Set(labels.map(l=>l.claim)).size!==labels.length) throw new Error('Incomplete audit cases');
  const rows=corpus.claims.map(c=>({claim:c.id,observed:truth[c.id],expected:corpus.labels.find(l=>l.claim===c.id && l.checkpoint===checkpoint)?.truth}));
  const mismatch=rows.filter(r=>r.observed!==r.expected);
  if(mismatch.length) throw new Error(`Oracle disagreement at ${checkpoint}: ${JSON.stringify(mismatch)}`);
  return rows;
}
