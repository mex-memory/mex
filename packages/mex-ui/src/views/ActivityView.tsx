import { ActivityPanel } from "./panels/ActivityPanel";
import type { Resource } from "../lib/hooks";
import type { ActivityPayload } from "../lib/types";

export function ActivityView(props: { activity: Resource<ActivityPayload> }) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div className="page-head__text">
          <h1>Activity</h1>
          <p className="page-head__sub">
            Recent events from <code className="mono">mex log</code> — decisions, notes, risks, and
            todos.
          </p>
        </div>
      </div>
      <ActivityPanel activity={props.activity} />
    </div>
  );
}
