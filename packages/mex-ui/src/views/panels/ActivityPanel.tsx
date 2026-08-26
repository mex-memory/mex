import { Badge, Card, EmptyState, ErrorState, Icon, SkeletonRows } from "../../components/primitives";
import { formatRelativeTime } from "../../lib/format";
import type { Resource } from "../../lib/hooks";
import type { ActivityPayload, EventEntry } from "../../lib/types";

const KIND_TONE: Record<EventEntry["kind"], "info" | "warn" | "bad" | "neutral"> = {
  decision: "info",
  note: "neutral",
  risk: "bad",
  todo: "warn",
};

/** The `mex log` event trail — what the team and its agents decided, recently. */
export function ActivityPanel(props: { activity: Resource<ActivityPayload> }) {
  const { data, error, loading, reload } = props.activity;

  if (loading) {
    return (
      <Card title="Recent activity" icon={Icon.clock()}>
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card title="Recent activity" icon={Icon.clock()}>
        <ErrorState
          message={error?.message ?? "No activity was returned."}
          hint={error?.hint}
          onRetry={reload}
        />
      </Card>
    );
  }

  if (data.events.length === 0) {
    return (
      <Card title="Recent activity" icon={Icon.clock()}>
        <EmptyState
          icon={Icon.clock({ size: 18 })}
          title="No events logged yet"
          body={
            <>
              Record decisions as you make them with{" "}
              <code className="mono">mex log &quot;chose X over Y&quot; --type decision</code>. Your agent
              can append to the same log, so future sessions inherit the reasoning.
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card
      title="Recent activity"
      icon={Icon.clock()}
      flush
      hint={`${data.events.length} latest`}
    >
      <div className="rows">
        {data.events.map((event, index) => (
          <div className="row" key={`${event.timestamp}-${index}`}>
            <div className="row__main">
              <div className="row__title">
                <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>
                <span className="row__text">{event.message}</span>
              </div>
              {event.files.length > 0 && (
                <div className="row__sub mono">{event.files.join(", ")}</div>
              )}
            </div>
            <span className="row__aside nowrap" title={event.timestamp}>
              {formatRelativeTime(event.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
