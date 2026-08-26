import { Banner, Button, Card, Facts, Icon } from "../components/primitives";
import { ScaffoldCoverage } from "./panels/ScaffoldCoverage";
import type { ProjectSnapshot } from "../lib/types";

/**
 * `.mex/` exists but mex can't load it. This is a repairable state, so the view
 * leads with the fix rather than the failure.
 */
export function ProblemView(props: {
  snapshot: ProjectSnapshot;
  onStartSetup: () => void;
  onRetry: () => void;
}) {
  const { snapshot, onStartSetup, onRetry } = props;
  const error = snapshot.error;

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__text">
          <h1>This scaffold needs attention</h1>
          <p className="page-head__sub">
            mex found a <code className="mono">.mex/</code> directory here but couldn't load it.
          </p>
        </div>
        <div className="cluster">
          <Button onClick={onRetry}>{Icon.refresh()} Re-check</Button>
          {error?.canRunSetup && (
            <Button variant="primary" onClick={onStartSetup}>
              Repair with setup {Icon.arrowRight()}
            </Button>
          )}
        </div>
      </div>

      <Banner tone="bad" title={error?.message ?? "The scaffold could not be read."} icon={Icon.warning()}>
        {error?.hint}
      </Banner>

      <div className="grid grid--split">
        <ScaffoldCoverage snapshot={snapshot} />

        <Card title="What mex saw" icon={Icon.folder()}>
          <Facts
            items={[
              { key: "Project", value: <span className="mono">{snapshot.projectRoot}</span> },
              {
                key: "Scaffold",
                value: <span className="mono">{snapshot.scaffoldRoot ?? "not found"}</span>,
              },
              {
                key: "Identity",
                value: snapshot.identity ? (
                  <span className="mono">{snapshot.identity.scaffold_id}</span>
                ) : (
                  <span className="dim">none recorded</span>
                ),
              },
              {
                key: "Code graph",
                value: snapshot.graph.present ? "present" : <span className="dim">not built</span>,
              },
              { key: "mex", value: <span className="mono">{snapshot.version}</span> },
            ]}
          />
          <p className="dim" style={{ marginTop: 14, fontSize: "0.84rem" }}>
            Setup is safe to re-run: files that already hold real content are never overwritten.
          </p>
        </Card>
      </div>
    </div>
  );
}
