import { DriftPanel } from "./panels/DriftPanel";
import { HeartbeatCard } from "./panels/HeartbeatCard";
import type { Resource } from "../lib/hooks";
import type { ActivityPayload, DriftPayload } from "../lib/types";

export function HealthView(props: {
  drift: Resource<DriftPayload>;
  activity: Resource<ActivityPayload>;
}) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Health</h1>
          <p className="page-head__sub">
            Drift findings and heartbeat staleness. Repair still happens in your editor via{" "}
            <code className="mono">mex sync</code>.
          </p>
        </div>
      </div>
      <DriftPanel drift={props.drift} />
      <HeartbeatCard activity={props.activity} />
    </div>
  );
}
