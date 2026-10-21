#!/usr/bin/env node
/** Compare two offline composer replays with the classified item inventory. */
import { readFileSync, writeFileSync } from 'node:fs';

const [beforePath, afterPath, auditPath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: context-notes-summary.mjs BEFORE AFTER AUDIT OUTPUT_PREFIX');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const before = read(beforePath), after = read(afterPath), audit = read(auditPath);
const notes = replay => replay.notes.filter(n => !n.diagnostic && n.text.length > 0);
const oldNotes = notes(before), newNotes = notes(after);
const byRun = (rows, run) => rows.filter(n => n.run === run);
const rows = before.sessions.map(old => {
  const next = after.sessions.find(n => n.run === old.run);
  if (!next) throw new Error(`Missing session: ${old.run}`);
  return { run: old.run, arm: old.arm, before: old.totalChars, after: next.totalChars,
    goldBefore: byRun(oldNotes, old.run).filter(n => n.gold).length,
    goldAfter: byRun(newNotes, old.run).filter(n => n.gold).length, coverage: next.coverage };
});
if (rows.length !== after.sessions.length) throw new Error('Session count differs');
const aggregate = [...new Set(rows.map(r => r.arm))].sort().map(arm => {
  const group = rows.filter(r => r.arm === arm);
  const sum = key => group.reduce((a, r) => a + r[key], 0);
  return { arm, sessions: group.length, before: sum('before'), after: sum('after'),
    reduction: 1 - sum('after') / sum('before'), goldBefore: sum('goldBefore'), goldAfter: sum('goldAfter') };
});
const hasName = (text, name) => text.includes(`#${name} `) || text.includes(`#${name};`) || text.includes(`#${name}\n`);
const classified = audit.map(item => {
  const original = oldNotes.find(n => n.run === item.runId && n.turn === item.after);
  const source = item.kind === 'graph' && original?.text.includes('MEX graph (')
    ? original.text.slice(original.text.indexOf('MEX graph (')) : item.text;
  const names = [...source.matchAll(/#([A-Za-z_$][\w$.]*)/g)].map(m => m[1]);
  const ids = item.kind === 'knowledge' ? original?.ids ?? [] : [];
  const titles = [...item.text.matchAll(/(?:fact \[[^\]]+\](?: \(\+\d+ more\))?: |MEX knowledge[^\n]*? — )([^\n·—]+)/g)].map(m => m[1].trim());
  const survives = n => ids.some(id => n.ids.includes(id) || n.text.includes(id)) || titles.some(t => n.text.includes(t)) ||
    (item.kind === 'graph' && names.some(name => hasName(n.text, name)));
  const candidates = byRun(newNotes, item.runId);
  // Session availability tolerates dedup moving evidence to an earlier event;
  // delayed evidence is bounded by the audit's five-call follow-up window.
  const sessionKept = candidates.some(n => n.turn <= item.after + 5 && (item.event !== 'edit' || n.event === 'edit') && survives(n));
  const eventKept = candidates.some(n => n.turn === item.after && survives(n));
  return { n: item.n, classification: item.final, kind: item.kind, event: item.event,
    sessionKept, eventKept, oldEventReproduced: Boolean(original) };
});
const classifications = [...new Set(audit.map(i => i.final))].sort().map(classification => {
  const group = classified.filter(i => i.classification === classification);
  return { classification, total: group.length, sessionKept: group.filter(i => i.sessionKept).length,
    eventRemoved: group.filter(i => !i.eventKept).length, lost: group.filter(i => !i.sessionKept).map(i => i.n) };
});
const coverage = Object.fromEntries(Object.keys(rows[0].coverage).map(key => [key, rows.reduce((sum, r) => sum + r.coverage[key], 0)]));
const claimChecks = [
  { item: 81, claim: 'const enum member accesses are never inlined even if the enum is preserved' },
  { item: 88, claim: 'bypass branch of a switch without a default clause as a contributor only if the switch is not `isExhaustiveSwitchStatement()`' },
].map(check => {
  const item = audit.find(i => i.n === check.item);
  return { ...check, present: Boolean(item && newNotes.some(n => n.run === item.runId && n.turn === item.after && n.text.includes(check.claim))) };
});
const result = { methodology: 'All sessions, copied base indexes, observed prompt gates for existing arms and lexical prompt counterfactual for files. Gold counts are literal file/symbol coverage. Classified items survive if any original fact id/title or graph symbol is present, including dedup into knowledge; session coverage permits earlier delivery or delivery within five following calls. Event removal compares the same tool-call position. Pointer/identity coverage does not establish preserved answer quality. Unmapped shell writes have no fabricated diff.', aggregate, coverage, classifications, classified, sessions: rows,
  claimChecks,
  editMexPointers: newNotes.filter(n => n.event === 'edit' && n.text.includes('.mex/')).length };
writeFileSync(`${output}.json`, JSON.stringify(result, null, 2));
let md = '| Arm | Sessions | Before chars | After chars | Reduction | Gold notes before/after |\n|---|---:|---:|---:|---:|---:|\n';
for (const row of aggregate) md += `| ${row.arm} | ${row.sessions} | ${row.before} | ${row.after} | ${(100 * row.reduction).toFixed(1)}% | ${row.goldBefore}/${row.goldAfter} |\n`;
md += '\n| Session | Arm | Before chars | After chars | Gold notes before/after |\n|---|---|---:|---:|---:|\n';
for (const row of rows) md += `| ${row.run} | ${row.arm} | ${row.before} | ${row.after} | ${row.goldBefore}/${row.goldAfter} |\n`;
md += `\nCoverage: ${JSON.stringify(coverage)}\n\nClassified items: ${JSON.stringify(classifications)}\n\n${result.methodology}\n`;
writeFileSync(`${output}.md`, md);
console.log(JSON.stringify({ aggregate, classifications, coverage, claimChecks, editMexPointers: result.editMexPointers }));
