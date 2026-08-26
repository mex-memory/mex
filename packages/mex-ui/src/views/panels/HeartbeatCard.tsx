import { Badge, Card, Icon } from "../../components/primitives";
import type { Resource } from "../../lib/hooks";
import type { ActivityPayload } from "../../lib/types";

export function HeartbeatCard(props: { activity: Resource<ActivityPayload> }) {
  const heartbeat = props.activity.data?.heartbeat;

  if (!heartbeat) return null;

  if (heartbeat.ok) {
    return (
      <Card title="Heartbeat" icon={Icon.pulse()}>
        <div className="cluster">
          <Badge tone="good" dot>
            Fresh
          </Badge>
          <span className="muted" style={{ fontSize: "0.87rem" }}>
            Every scaffold file was updated recently enough.
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Heartbeat" icon={Icon.pulse()} flush>
      <div className="rows">
        {heartbeat.staleFiles.map((file) => (
          <div className="row" key={file.file}>
            <span className="sev sev--warning" aria-hidden="true" />
            <div className="row__main">
              <div className="row__title">
                <span className="row__text mono">{file.file}</span>
              </div>
              <div className="row__sub">Frontmatter says it hasn't been touched in {file.days} days</div>
            </div>
          </div>
        ))}
        {heartbeat.memoryCleanupDue && (
          <div className="row">
            <span className="sev sev--warning" aria-hidden="true" />
            <div className="row__main">
              <div className="row__title">
                <span className="row__text">Memory cleanup is due</span>
              </div>
              <div className="row__sub">
                {heartbeat.oldDailyMemoryFiles.length > 0
                  ? `${heartbeat.oldDailyMemoryFiles.length} daily memory files are past retention.`
                  : "Run the cleanup step described in .mex/HEARTBEAT.md."}
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
