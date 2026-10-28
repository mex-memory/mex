import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { StatechartArtifact } from "@mex/hub-contracts/statechart";
import { fitStatechartView, layoutStatechartGraph, statechartEdgePath } from "../lib/statechart-graph";
import styles from "../styles/statechart-graph.module.css";

const emptySteps: StatechartArtifact["traces"][number]["steps"] = [];
function visits(ids: readonly number[]): string { return ids.length > 4 ? `${ids.slice(0, 4).join(", ")} +${ids.length - 4}` : ids.join(", "); }
function GraphLabel({ text, width, height, fontSize, color, plate }: { text: string; width: number; height: number; fontSize: number; color: string; plate?: boolean }) {
  const columns = Math.max(8, Math.floor((width - 14) / (fontSize * .56))), lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > columns) { lines.push(line); line = ""; }
    if (word.length > columns) {
      if (line) { lines.push(line); line = ""; }
      for (let i = 0; i < word.length; i += columns) lines.push(word.slice(i, i + columns));
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  const spacing = fontSize * 1.35, y = (height - lines.length * spacing) / 2 + fontSize;
  const plateHeight = Math.max(height, lines.length * spacing + 12);
  return <>{plate !== undefined && <rect y={(height - plateHeight) / 2} width={width} height={plateHeight} rx="5" fill="var(--background)" stroke={plate ? "var(--primary-border)" : "none"} />}<text textAnchor="middle" fontSize={fontSize} fill={color} stroke="var(--background)" strokeWidth="3" paintOrder="stroke" pointerEvents="none">{lines.map((value, i) => <tspan x={width / 2} y={y + i * spacing} key={i}>{value}</tspan>)}</text></>;
}

export function StatechartCanvas({ artifact, highlighted, selected, onSelect, steps = emptySteps }: {
  artifact: StatechartArtifact; highlighted: string[]; selected?: string | null;
  steps?: StatechartArtifact["traces"][number]["steps"]; onSelect(id: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const marker = `statechart-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [size, setSize] = useState({ width: 760, height: 620 });
  const graph = useMemo(() => { try { return layoutStatechartGraph(artifact); } catch { return null; } }, [artifact]);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [allEvents, setAllEvents] = useState(artifact.transitions.length <= 8);
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const pathStates = new Set(highlighted), pathEdges = new Set(steps.flatMap(step => step.transition ? [step.transition] : []));
  const active = hovered ?? selected;
  const activeEdge = artifact.transitions.find(edge => edge.id === active);
  const neighbors = new Set(artifact.transitions.filter(edge => edge.from === active || edge.to === active || edge === activeEdge).flatMap(edge => [edge.from, edge.to]));
  const violations = new Set(artifact.traces.filter(trace => trace.kind === "counterexample" && artifact.check.results.some(result => result.rule === trace.rule && result.outcome === "violated")).flatMap(trace => trace.steps.at(-1)?.state ?? []));
  const activate = (event: KeyboardEvent<SVGGElement>, id: string) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(id); } };

  useEffect(() => {
    if (!root.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (graph) setView(fitStatechartView(graph, size)); }, [graph, size]);
  function zoom(factor: number) {
    if (!graph) return;
    setView(current => {
      const scale = Math.max(Math.min(.2, fitStatechartView(graph, size).scale), Math.min(3, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: size.width / 2 - (size.width / 2 - current.x) * ratio, y: size.height / 2 - (size.height / 2 - current.y) * ratio };
    });
  }
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); zoom(event.deltaY > 0 ? .9 : 1.1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [graph, size]);

  return <div>
    <div className={styles.toolbar}><span>{artifact.states.length} states · {artifact.transitions.length} transitions</span><span>◉ Initial{steps.length > 0 ? " · Recorded path highlighted" : ""}{violations.size > 0 ? " · Rule violations marked" : ""}</span><button type="button" aria-pressed={allEvents} onClick={() => setAllEvents(value => !value)}>{allEvents ? "All events" : "Events on selection"}</button></div>
    <div className={styles.canvas} role="region" aria-label="State diagram" tabIndex={0} ref={root}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const moves: Record<string, [number, number]> = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
        const move = moves[event.key];
        if (move) { event.preventDefault(); setView(current => ({ ...current, x: current.x + move[0], y: current.y + move[1] })); }
        if (event.key === "+" || event.key === "=") zoom(1.2);
        if (event.key === "-") zoom(1 / 1.2);
        if (event.key === "Escape" && graph) setView(fitStatechartView(graph, size));
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("button,path,[role=button]")) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, baseX: view.x, baseY: view.y };
      }}
      onPointerMove={event => { const d = drag.current; if (d) setView(current => ({ ...current, x: d.baseX + event.clientX - d.x, y: d.baseY + event.clientY - d.y })); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {!graph ? <p role="status">Diagram rendering is unavailable. The complete state and transition lists remain available below.</p> : <svg role="group" aria-label="States and transitions" className={styles.world} width={graph.width} height={graph.height} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {graph.groups.map(({ id, region, state, box }) => <g key={id} role="group" aria-label={region ? `Independent region ${region}` : `Within ${artifact.states.find(item => item.id === state)?.label}`}>
          <rect {...box} rx="10" fill={region ? "none" : "var(--card)"} fillOpacity=".4" stroke="var(--border)" strokeDasharray={region ? "4 4" : undefined} />
          {region && <text x={box.x + 12} y={box.y + 18} fill="var(--muted-foreground)" fontSize="11">{region}</text>}
        </g>)}
          <defs>{["normal", "active", "path"].map(tone => <marker id={`${marker}-${tone}`} key={tone} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={tone === "normal" ? "var(--muted-foreground)" : "var(--primary)"} strokeWidth="1.2" /></marker>)}</defs>
          {artifact.transitions.map(edge => {
            const focused = edge.id === active || edge.from === active || edge.to === active, inPath = pathEdges.has(edge.id);
            const dimmed = !!active && !focused || steps.length > 0 && !inPath;
            return <path key={edge.id} d={statechartEdgePath(graph.edges.get(edge.id)!.points)} className={styles.edge} fill="none" stroke={focused || inPath ? "var(--primary)" : "var(--muted-foreground)"} strokeWidth={focused || inPath ? 1.5 : 1} strokeOpacity={dimmed ? .15 : focused || inPath ? .9 : .4} markerEnd={`url(#${marker}-${focused ? "active" : inPath ? "path" : "normal"})`} onMouseEnter={() => setHovered(edge.id)} onMouseLeave={() => setHovered(null)} onClick={() => onSelect(edge.id)} />;
          })}
        {artifact.transitions.map(edge => {
          const focused = edge.id === active || edge.from === active || edge.to === active, inPath = pathEdges.has(edge.id);
          const numbers = steps.flatMap((step, i) => step.transition === edge.id ? [i + 1] : []);
          const box = graph.edges.get(edge.id)!.label;
          return <g key={edge.id} role="button" tabIndex={0} className={styles.event} transform={`translate(${box.x} ${box.y})`} aria-label={`${edge.event} · ${artifact.states.find(state => state.id === edge.from)?.label} → ${artifact.states.find(state => state.id === edge.to)?.label}`} aria-pressed={selected === edge.id} data-visible={allEvents || focused || inPath || undefined} onMouseEnter={() => setHovered(edge.id)} onMouseLeave={() => setHovered(null)} onClick={() => onSelect(edge.id)} onKeyDown={event => activate(event, edge.id)}>
            <title>{edge.condition ? `${edge.event}\n${edge.condition}` : edge.event}</title>
            <GraphLabel text={`${numbers.length ? `${visits(numbers)}. ` : ""}${edge.event}`} width={box.width} height={box.height} fontSize={Math.min(18, Math.max(11, 11 / view.scale))} color={focused ? "var(--foreground)" : inPath ? "var(--primary)" : "var(--muted-foreground)"} plate={focused || inPath} />
          </g>;
        })}
        {artifact.states.map(state => {
          const numbers = steps.flatMap((step, i) => step.state === state.id ? [i + 1] : []), inPath = pathStates.has(state.id), initial = artifact.initial.includes(state.id);
          const box = graph.nodes.get(state.id)!, color = violations.has(state.id) ? "var(--destructive)" : initial ? "#8eb5dc" : "#75b8b0";
          const picked = selected === state.id || inPath, dimmed = !!active && active !== state.id && !neighbors.has(state.id) || steps.length > 0 && !inPath;
          return <g key={state.id} role="button" tabIndex={0} className={styles.node} transform={`translate(${box.x} ${box.y})`} aria-label={`${numbers.length ? `${numbers.join(", ")}. ` : ""}${state.label}${initial ? " · initial state" : ""}`} aria-pressed={selected === state.id} data-violation={violations.has(state.id) || undefined} onMouseEnter={() => setHovered(state.id)} onMouseLeave={() => setHovered(null)} onClick={() => onSelect(state.id)} onKeyDown={event => activate(event, state.id)}>
            <title>{state.label}</title><rect width={box.width} height={box.height} fill="transparent" />
            <circle cx={box.width / 2} cy="18" r="13" fill={picked ? "var(--primary-soft)" : color} fillOpacity={picked ? 1 : .08} />
            <circle cx={box.width / 2} cy="18" r="8" fill={color} fillOpacity={dimmed ? .15 : .38} stroke={picked ? "var(--primary)" : color} strokeWidth={picked ? 2 : 1} />
            <g transform="translate(0 36)"><GraphLabel text={`${numbers.length ? `${visits(numbers)}. ` : ""}${state.label}`} width={box.width} height={box.height - 36} fontSize={Math.min(20, Math.max(12, 12 / view.scale))} color={dimmed ? "var(--muted-foreground)" : "var(--foreground)"} /></g>
          </g>;
        })}
      </svg>}
      <div aria-label="Diagram controls" className={styles.controls}>
        <button aria-label="Zoom out" title="Zoom out" type="button" onClick={() => zoom(1 / 1.2)}><Minus size={14} /></button>
        <button aria-label="Fit diagram" title="Fit diagram" type="button" onClick={() => graph && setView(fitStatechartView(graph, size))}><Maximize2 size={14} /></button>
        <button aria-label="Zoom in" title="Zoom in" type="button" onClick={() => zoom(1.2)}><Plus size={14} /></button>
        <span aria-live="polite">{Math.round(view.scale * 100)}%</span>
      </div>
      <p className={styles.hint}>Select a state to follow its events · Drag to pan · Ctrl / ⌘ scroll to zoom</p>
    </div>
  </div>;
}
