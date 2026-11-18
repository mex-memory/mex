import { expect, it } from "vitest";
// This audit deliberately uses plain source declarations, outside the evaluator.
// @ts-expect-error The independent audit is a standalone Node module.
import { observedTruth, verifyTruth } from "../scripts/knowledge-bench/audit-oracle.mjs";
const probes=()=>({b01:{status:200,same:true},b02:{path:'/あ'},b03:{calls_timing_safe_equal:true},b04:{get_default_ok:{status:200},head_default_ok:{status:200},get_default_missing:{status:301},head_default_missing:{status:301},option_ok:{status:200}},b05:{vary:'Origin'},v04:{status:304,headers:{'cache-control':'max-age=60','content-location':'/item',date:'Mon, 16 Nov 2026 00:00:00 GMT',etag:'"tag"',expires:'Tue, 17 Nov 2026 00:00:00 GMT',vary:'Accept-Language'}},b06:{generated:{headers:{etag:'W/"tag"'}},preset:{headers:{etag:'"preset"'}}},b07:{status:200},b08:{content_type:'application/json'},b09:{status:400,body:'Malformed JSON in request body'},b10:{length:{status:413,body:'Payload Too Large'},stream:{status:200},override:{status:418}},b11:{fallback_hits:1,matched:true},b12:{small:{encoding:'gzip'},small_with_length:{encoding:null as string|null},large:{encoding:'gzip'}},b13:{parse_uses_strict:true,parse_uses_relaxed:false,parsed:{plain:'value'} as Record<string,string>,serializer_rejects_colon:true},mime:{csv:'text/csv; charset=utf-8',mjs:'text/javascript; charset=utf-8',svg:'image/svg+xml',json:'application/json',png:'image/png',wasm:'application/wasm',avif:'image/avif'},b14:{status:418,handler_hits:1}});
const sources={'package.json':'{}','src/router.ts':"export const METHODS = ['get', 'post', 'put', 'delete', 'options', 'patch']; export const METHOD_NAME_ALL = 'ALL'",'src/middleware/compress/index.ts':"const ENCODING_TYPES = ['gzip', 'deflate']",'src/utils/mime.ts':"csv: 'text/csv',\nmjs: 'text/javascript',\nsvg: 'image/svg+xml',\njson: 'application/json',\npng: 'image/png',\nwasm: 'application/wasm',\navif: 'image/avif'"};
it("audits conditions separately from explicit overrides and unknown-length controls",()=>{
 const f=probes(), truth=observedTruth(f,sources,sources);
 expect(truth).toMatchObject({b06:true,b10:true,b12:true,b13:true,v04:true,v06:true,v07:true});
 f.b10.stream.status=413;f.b10.override.status=201;f.b06.preset.headers.etag='"other"';
 expect(observedTruth(f,sources,sources)).toEqual(truth);
 f.b10.length.status=200;f.b12.small_with_length.encoding='gzip';f.v04.headers.vary='';
 expect(observedTruth(f,sources,sources)).toMatchObject({b10:false,b12:false,v04:false});
});
it("distinguishes the parser from the serializer and raw MIME mappings from derived headers",()=>{
 const f=probes();f.b13.parse_uses_strict=false;f.b13.parse_uses_relaxed=true;f.b13.parsed['paraglide:lang']='en';
 expect(observedTruth(f,sources,sources)).toMatchObject({b13:false,v06:true});
 expect(observedTruth(f,{...sources,'src/utils/mime.ts':sources['src/utils/mime.ts'].replace("csv: 'text/csv'","csv: 'text/csv; charset=utf-8'")},sources).v06).toBe(false);
});
it("rejects missing observations, duplicate or mismatched expected cases",()=>{
 const f=probes();delete (f.b13 as any).parse_uses_strict;
 expect(()=>observedTruth(f,sources,sources)).toThrow('Incomplete behavior probe');
 const truth=observedTruth(probes(),sources,sources), claims=Object.keys(truth).map(id=>({id}));
 const corpus={claims,labels:claims.map(c=>({claim:c.id,checkpoint:'C0',truth:truth[c.id]}))};
 expect(verifyTruth(truth,corpus,'C0')).toHaveLength(46);
 const duplicate=structuredClone(corpus);duplicate.claims[1]=duplicate.claims[0]!;expect(()=>verifyTruth(truth,duplicate,'C0')).toThrow('Incomplete audit');
 corpus.labels[0]!.truth=!corpus.labels[0]!.truth;
 expect(()=>verifyTruth(truth,corpus,'C0')).toThrow('Oracle disagreement');
 expect(()=>verifyTruth({},corpus,'C0')).toThrow('Incomplete audit');
});
