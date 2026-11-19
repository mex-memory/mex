// Read-only census of local budget outcomes and typed-prompt shortcut hits.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { transcript, convert } from './convert.mjs';
export function shortcutHits(text) {
    const words = new Set(text.toLowerCase().match(/\p{L}+/gu) || []);
    const changing = ['replace', 'migrate', 'remove', 'rename', 'deprecate'].some(w => words.has(w));
    const reproducing = ['reproduce', 'repro'].some(w => words.has(w)) || text.toLowerCase().includes('failing test');
    return { changing, reproducing, either: changing || reproducing };
}
export function ceilingOutcomes(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    try {
        const rows = db.prepare(`SELECT d.detail AS ceiling,coalesce(f.kind,'unobserved') AS followed,count(*) AS count FROM deliveries d LEFT JOIN followups f ON f.delivery_id=d.id WHERE d.action='held-back' AND d.detail IN ('moment-budget','epoch-budget','lane-budget','admission') GROUP BY d.detail,followed ORDER BY d.detail,followed`).all();
        const totals = db.prepare(`SELECT detail AS ceiling,count(*) AS heldReceipts FROM deliveries WHERE action='held-back' AND detail IN ('moment-budget','epoch-budget','lane-budget','admission') GROUP BY detail ORDER BY detail`).all();
        const afterSessionCeiling = db.prepare(`SELECT count(*) AS holdsAfterSessionCeiling FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch WHERE d.action='held-back' AND d.detail='admission' AND (SELECT coalesce(sum(p.tokens),0) FROM deliveries p WHERE p.session_id=d.session_id AND p.agent_id=d.agent_id AND p.rowid<d.rowid AND p.action IN ('given','replaced','shadow'))>3*e.budget`).get();
        const offers = db.prepare(`SELECT coalesce(lane,'legacy') AS lane,action,count(*) AS count FROM deliveries GROUP BY 1,2 ORDER BY 1,2`).all();
        const epochs = db.prepare('SELECT count(*) AS epochs FROM epochs').get();
        return { definition: 'Holdback receipts, with subsequent observations; one receipt may have multiple outcome kinds. Admission after the session ceiling is correlation, not an isolated causal ceiling test.', totals, rows, ...afterSessionCeiling, offers, ...epochs };
    }
    finally {
        db.close();
    }
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const qset = resolve(arg('--qset')), sessions = resolve(arg('--sessions'));
    const labels = readFileSync(join(qset, 'sessions', 'dev.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    const counts = { prompts: 0, changing: 0, reproducing: 0, either: 0 };
    for (const q of labels) {
        const records = await transcript(join(sessions, q.session));
        const events = convert(records, { session: q.session, project: 'study', checkout: '/study', oldRoot: q.checkout_root, subagent: q.session.includes('subagents') });
        for (const ev of events)
            if (ev.kind === 'prompt' && ev.prompt?.typed) {
                counts.prompts++;
                const hit = shortcutHits(ev.prompt.text);
                for (const key of ['changing', 'reproducing', 'either'])
                    counts[key] += Number(hit[key]);
            }
    }
    const report = { wordList: { definition: 'Rough activation frequency on real typed turns from dev sessions; no intent gold labels exist', ...counts, rates: Object.fromEntries(['changing', 'reproducing', 'either'].map(k => [k, counts[k] / counts.prompts])) }, ceilings: ceilingOutcomes(resolve(arg('--hooks'))) };
    writeFileSync(resolve(arg('--output')), JSON.stringify(report, null, 2) + '\n');
}
