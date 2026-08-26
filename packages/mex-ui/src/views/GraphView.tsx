import { Banner, Icon } from "../components/primitives";
import { GraphPanel } from "./panels/GraphPanel";
import type { Resource } from "../lib/hooks";
import type { GraphFileStatus, GraphStats, Job } from "../lib/types";

export function GraphView(props: {
  graph: Resource<GraphStats>;
  file: GraphFileStatus;
  buildJob: Job | null;
  building: boolean;
  buildError: string | null;
  onBuild: () => void;
}) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Graph</h1>
          <p className="page-head__sub">
            Index totals and parse health. Symbol browsing stays in{" "}
            <code className="mono">mex graph query</code> until the explorer lands.
          </p>
        </div>
      </div>

      {props.buildError && (
        <Banner tone="bad" title="The graph build failed" icon={Icon.warning()}>
          {props.buildError}
        </Banner>
      )}

      <GraphPanel
        graph={props.graph}
        file={props.file}
        buildJob={props.buildJob}
        building={props.building}
        onBuild={props.onBuild}
      />
    </div>
  );
}
