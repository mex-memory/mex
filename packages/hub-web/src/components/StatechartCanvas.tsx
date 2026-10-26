import { useEffect, useRef, useState } from "react";
import { statechartMermaid, type StatechartArtifact } from "@mex/hub-contracts/statechart";
import { Button } from "./primitives/button";
import styles from "../styles/diagrams.module.css";
let serial = Promise.resolve();
let sequence = 0;
const emptySteps: StatechartArtifact["traces"][number]["steps"] = [];
/** Strict, closed generated Mermaid only. No imported source directives reach this component. */
export function StatechartCanvas({ artifact, highlighted, onSelect, steps = emptySteps }: { artifact: StatechartArtifact; highlighted: string[]; steps?: StatechartArtifact["traces"][number]["steps"]; onSelect(id: string): void }) {
  const [svg, setSvg] = useState(""); const [error, setError] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true; setError(false); setSvg("");
    const task = async () => {
      if (!current) return;
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 64 * 1024, maxEdges: 200, theme: "neutral", htmlLabels: false, state: { useMaxWidth: false } });
        // Highlight is an allowlisted presentation overlay; it adds no graph edges.
        const ids = highlighted.filter(id => artifact.states.some(s => s.id === id));
        const projected = steps.length ? statechartMermaid({ ...artifact,
          states: artifact.states.map(s => { const visits = steps.flatMap((step, i) => step.state === s.id ? [i + 1] : []); return { ...s, label: visits.length ? `${visits.join(", ")}. ${s.label}` : s.label }; }),
          transitions: artifact.transitions.map(t => { const visits = steps.flatMap((step, i) => step.transition === t.id ? [i + 1] : []); return { ...t, event: visits.length ? `${visits.join(", ")}. ${t.event}` : t.event }; }),
        }) : artifact.diagram.mermaid;
        const source = projected + (ids.length ? `\nclassDef selected stroke:#137dba,stroke-width:4px\nclass ${ids.join(",")} selected\n` : "");
        const result = await mermaid.render(`mex_diagram_${++sequence}`, source);
        if (current) setSvg(result.svg);
      } catch { if (current) setError(true); }
    };
    serial = serial.then(task, task);
    return () => { current = false; };
  }, [artifact, highlighted, steps]);
  function selectState(target: EventTarget) {
    let node = target instanceof Element ? target : null;
    while (node && node !== root.current) {
      const id = node.getAttribute("data-id") ?? node.id;
      const state = artifact.states.find(s => id === s.id || id.startsWith(`state-${s.id}-`));
      if (state) { onSelect(state.id); return; }
      node = node.parentElement;
    }
  }
  function zoom(delta: number) { setView(v => ({ ...v, zoom: Math.max(.2, Math.min(4, v.zoom + delta)) })); }
  return <div className={styles.diagram}>
    <div className={styles.toolbar} aria-label="Diagram controls">
      <Button size="sm" variant="outline" onClick={() => zoom(.2)} aria-label="Zoom in">+</Button>
      <Button size="sm" variant="outline" onClick={() => zoom(-.2)} aria-label="Zoom out">−</Button>
      <Button size="sm" variant="outline" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>Fit diagram</Button>
      <span aria-live="polite">{Math.round(view.zoom * 100)}%</span><span className={styles.panHelp}>Drag to pan · Arrow keys to move</span>
    </div>
    <div className={styles.canvas} role="region" aria-label="State diagram" tabIndex={0} ref={root}
      onKeyDown={e => { const d: Record<string, [number, number]> = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] }; const move = d[e.key]; if (move) { e.preventDefault(); setView(v => ({ ...v, x: v.x + move[0], y: v.y + move[1] })); } if (e.key === "+") zoom(.2); if (e.key === "-") zoom(-.2); if (e.key === "Escape") setView({ x: 0, y: 0, zoom: 1 }); }}
      onPointerDown={e => { if (e.button !== 0) return; selectState(e.target); drag.current = { x: e.clientX, y: e.clientY, baseX: view.x, baseY: view.y }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const d = drag.current; if (d) setView(v => ({ ...v, x: d.baseX + e.clientX - d.x, y: d.baseY + e.clientY - d.y })); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onClick={e => selectState(e.target)}>
      {error ? <p role="status">Diagram rendering is unavailable. The complete state and transition lists remain available below.</p> : !svg ? <p role="status">Rendering state diagram…</p> : <div className={styles.svg} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  </div>;
}
