import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DiagramDetail, DiagramSavePlan } from "@mex/hub-contracts/statechart";
import { useHubApi } from "../api/context";
import { HubApiError } from "../api/client";
import { PageHeader, StatePanel } from "../components/ui";
import { Button } from "../components/primitives/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/dialog";
import styles from "../styles/diagrams.module.css";
const Canvas = lazy(async () => ({ default: (await import("../components/StatechartCanvas")).StatechartCanvas }));
const none: string[] = [];
export function DiagramsPage() {
  const { kind, id } = useParams();
  return id ? <DiagramReader key={`${kind}/${id}`} kind={kind} id={id} /> : <DiagramCollection />;
}
function ErrorPanel({ error, retry }: { error: unknown; retry(): void }) {
  return <StatePanel state="unavailable" title="Diagram unavailable" detail={error instanceof HubApiError ? error.problem.detail : "The diagram could not be read. Temporary previews may have expired; generate a new preview if needed."} action={<Button onClick={retry}>Try again</Button>} />;
}
function DiagramCollection() {
  const api = useHubApi();
  const q = useQuery({ queryKey: ["diagrams"], queryFn: () => { if (!api.listDiagrams) throw new Error("Unavailable"); return api.listDiagrams(); }, retry: false });
  return <div className={styles.page}><PageHeader eyebrow="Behavior" title="Diagrams" description="Explore checked explanations of how your system behaves." />
    <p className={styles.intro}>Ask your coding agent for a state diagram. Previews stay in this checkout for up to 24 hours. Saved snapshots stay in the working tree until you share them through Git.</p>
    {q.error ? <ErrorPanel error={q.error} retry={() => void q.refetch()} /> : !q.data ? <StatePanel state="loading" title="Loading diagrams" detail="Reading this checkout’s previews and saved snapshots." /> : <>
      {(["preview", "saved"] as const).map(kind => <section key={kind}><h2>{kind === "preview" ? "Temporary previews" : "Saved snapshots"} <span className={styles.count}>{q.data.items.filter(d => d.kind === kind).length}</span></h2>
        {!q.data.items.some(d => d.kind === kind) ? <p className={styles.empty}>{kind === "preview" ? "No temporary previews. Invoke mex-statechart in your agent to create one." : "No saved snapshots. Review a preview and choose Save to keep it."}</p> : <div className={styles.collection}>{q.data.items.filter(d => d.kind === kind).map(d => <Link key={d.id} to={`/diagrams/${kind}/${d.id}`} className={styles.card}><span className={styles.eyebrow}>Model check · {d.outcome}</span><h3>{d.title}</h3><p>{d.summary}</p>{d.expiresAt && <small>Checkout-only · expires {new Date(d.expiresAt).toLocaleString()}</small>}</Link>)}</div>}
      </section>)}
    </>}
  </div>;
}
function DiagramReader({ kind, id }: { kind?: string; id: string }) {
  const api = useHubApi();
  const q = useQuery({ queryKey: ["diagram", kind, id], queryFn: () => { if (!api.getDiagram || kind !== "preview" && kind !== "saved") throw new Error("Unavailable"); return api.getDiagram(kind, id); }, retry: false });
  return <div className={styles.page}><Link to="/diagrams">← All diagrams</Link>{q.error ? <ErrorPanel error={q.error} retry={() => void q.refetch()} /> : !q.data ? <StatePanel state="loading" title="Loading diagram" detail="Reading the recorded model and evidence." /> : <Workbench detail={q.data} />}</div>;
}
function Workbench({ detail }: { detail: DiagramDetail }) {
  const a = detail.artifact, api = useHubApi(), navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null), [pathId, setPathId] = useState("");
  const [plan, setPlan] = useState<DiagramSavePlan | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const trace = a.traces.find(t => t.id === pathId);
  const highlighted = useMemo(() => trace ? trace.steps.map(s => s.state) : none, [trace]);
  const state = a.states.find(s => s.id === selected), transition = a.transitions.find(t => t.id === selected), rule = a.rules.find(r => r.id === selected);
  const evidence = a.evidence.filter(e => e.explains.includes(selected ?? "") || state?.evidence.includes(e.id) || transition?.evidence.includes(e.id));
  async function preview() { setError(null); try { if (!api.previewDiagramSave) throw new Error(); setPlan(await api.previewDiagramSave(detail.id, detail.revision)); } catch { setError("Save review is unavailable. Reload this preview and try again."); } }
  async function save() { if (!plan || !api.saveDiagram) return; setSaving(true); setError(null); try { const result = await api.saveDiagram(plan.token); navigate(`/diagrams/saved/${result.id}`); } catch { setError("Save did not complete. Review the current preview again before retrying."); } finally { setSaving(false); } }
  return <>
    <div className={styles.heading}><PageHeader eyebrow={detail.kind === "preview" ? "Temporary · checkout-only" : "Saved snapshot · working tree"} title={a.title} description={a.summary} />{detail.kind === "preview" && <Button onClick={() => void preview()}>Review Save</Button>}</div>
    <p className={styles.intro}>{a.classification === "implemented" ? "Implemented behavior" : a.classification === "proposed" ? "Proposed behavior" : "Agreed model"} · {a.subject} · For {a.reader}</p>
    {detail.expiresAt && <p className={styles.intro}>Expires {new Date(detail.expiresAt).toLocaleString()}. Viewing does not retain this preview.</p>}
    <dl className={styles.statuses}><div><dt>Diagram</dt><dd>{a.diagram.validity}</dd></div><div><dt>Model check</dt><dd>{a.check.outcome}</dd></div><div><dt>Implementation reproduction</dt><dd>{a.reproduction.outcome}</dd></div><div><dt>Source mapping</dt><dd>{detail.alignment}</dd></div><div><dt>Evidence now</dt><dd>{detail.freshness.length ? [...new Set(detail.freshness.map(f => f.status))].join(", ") : "unverified"}</dd></div></dl>
    <p className={styles.notice}>A model check applies to the recorded model and bounds. Source hashes detect changes; they do not prove that this explanation remains correct.</p>
    <div className={styles.workbench}><div>
      <Suspense fallback={<p>Loading diagram viewer…</p>}><Canvas artifact={a} highlighted={highlighted} selected={selected} steps={trace?.steps} onSelect={setSelected} /></Suspense>
      <div className={styles.paths}><label>Recorded path <select aria-label="Recorded path" value={pathId} onChange={e => setPathId(e.target.value)}><option value="">Overview</option>{a.traces.map(t => <option key={t.id} value={t.id}>{t.kind} · {a.rules.find(r => r.id === t.rule)?.label ?? t.rule}</option>)}</select></label>
        {trace && <><p>{trace.kind === "goal" ? "Expected reachability witness" : trace.kind === "temporal" ? "Temporal counterexample — the full trace may not form a finite chart path" : "Model counterexample — implementation reproduction is separate"}</p><ol>{trace.steps.map((s, i) => <li key={i}><button onClick={() => setSelected(s.transition ?? s.state)}>{a.states.find(x => x.id === s.state)?.label}{s.transition ? ` — ${a.transitions.find(t => t.id === s.transition)?.event}` : ""}</button></li>)}</ol><details><summary>Full checker trace</summary><pre>{trace.raw}</pre></details></>}
      </div>
    </div><aside className={styles.details} aria-label="Diagram details"><h2>{state?.label ?? transition?.event ?? rule?.label ?? "Inspect behavior"}</h2>
      {state?.parent && <p>Within {a.states.find(s => s.id === state.parent)?.label}{state.region ? ` / ${state.region}` : ""}</p>}
      {transition && <><p>{a.states.find(s => s.id === transition.from)?.label} → {a.states.find(s => s.id === transition.to)?.label}</p><h3>Condition</h3><p>{transition.condition || "No additional condition recorded."}</p><h3>Rules</h3>{transition.rules.map(id => <p key={id}>{a.rules.find(r => r.id === id)?.label}</p>)}</>}
      {rule && <p>{rule.kind} · {rule.provenance}</p>}
      {!selected && <p>Select a state or transition in the diagram or lists to inspect its conditions and evidence.</p>}
      <h3>Evidence</h3>{!evidence.length ? <p>No evidence recorded for this selection.</p> : evidence.map(e => <div key={e.id} className={styles.evidence}><strong>{e.path}{e.line ? `:${e.line}` : ""}</strong><p>{e.note}</p><small>{e.kind} · {detail.freshness.find(f => f.evidence === e.id)?.status ?? "unverified"}</small></div>)}
    </aside></div>
    <section className={styles.lists} aria-label="Accessible behavior lists"><div><h2>States</h2><ul>{a.states.map(s => <li key={s.id}><button aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>{s.label}</button>{s.parent && <small>within {s.parent}{s.region ? ` / ${s.region}` : ""}</small>}</li>)}</ul></div><div><h2>Transitions</h2><ul>{a.transitions.map(t => <li key={t.id}><button aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}>{t.event}</button><p>{a.states.find(s => s.id === t.from)?.label} → {a.states.find(s => s.id === t.to)?.label}</p>{t.condition && <small>{t.condition}</small>}</li>)}</ul></div></section>
    <section><h2>Rules and limits</h2><p>{a.scope}</p><p>{a.check.bounds}</p>{a.rules.map(r => <article key={r.id}><h3><button className={styles.ruleButton} onClick={() => setSelected(r.id)}>{r.label}</button></h3><p>{r.kind} · {a.check.results.find(x => x.rule === r.id)?.outcome ?? "incomplete"}</p><p>{r.provenance}</p></article>)}<p>{a.reproduction.detail}</p>{a.omissions.length > 0 && <><h3>Omitted from this model</h3><ul>{a.omissions.map(o => <li key={o}>{o}</li>)}</ul></>}</section>
    <details><summary>Model, mapping and regeneration</summary><p>Regeneration is an explicit agent action and creates a new preview.</p><p>Runtime counts: {a.check.modelStates ?? "unavailable"} model states; {a.check.modelTransitions ?? "unavailable"} model transitions. Counts may describe partial exploration when checking did not pass.</p><pre>{JSON.stringify(a.toolchain, null, 2)}</pre><h3>Source mapping</h3><pre>{JSON.stringify(a.mapping, null, 2)}</pre>{a.files.map(f => <details key={f.name}><summary>{f.name}</summary><pre>{f.content}</pre></details>)}</details>
    {error && <p role="alert">{error}</p>}
    <Dialog open={!!plan} onOpenChange={open => { if (!open && !saving) setPlan(null); }}><DialogContent className={styles.saveDialog}><DialogTitle>Save a new snapshot</DialogTitle><DialogDescription>These exact files will be added to the working tree. Saving does not stage, commit or share them. Existing snapshots remain unchanged.</DialogDescription>{plan && <><p>{a.summary}</p><p>Model check: {a.check.outcome}. Reproduction: {a.reproduction.outcome}. Current evidence: {detail.freshness.map(f => f.status).join(", ") || "unverified"}.</p><p>Review the retained evidence, model and limitations in the record below.</p><div className={styles.writes}>{plan.writes.map(w => <details key={w.path}><summary>{w.path}</summary><pre>{w.content}</pre></details>)}</div><Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save snapshot"}</Button></>}{error && <p role="alert">{error}</p>}</DialogContent></Dialog>
  </>;
}
