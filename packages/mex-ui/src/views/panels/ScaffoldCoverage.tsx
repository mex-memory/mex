import { Badge, Card, Icon, Meter } from "../../components/primitives";
import { formatRelativeTime, percent } from "../../lib/format";
import type { ProjectSnapshot } from "../../lib/types";

/**
 * Per-file scaffold coverage. "Populated" uses the same template-placeholder
 * test setup uses, so this panel and the wizard always agree on which slots are
 * still empty.
 */
export function ScaffoldCoverage(props: { snapshot: ProjectSnapshot }) {
  const { scaffold } = props.snapshot;
  const filled = percent(scaffold.populated, scaffold.total);
  const tone = scaffold.populated === scaffold.total ? "good" : scaffold.populated === 0 ? "bad" : "warn";

  return (
    <Card
      title="Scaffold"
      icon={Icon.doc()}
      flush
      actions={
        <span className="dim tabular" style={{ fontSize: "0.8rem" }}>
          {scaffold.populated}/{scaffold.total} populated
        </span>
      }
    >
      <div style={{ padding: "14px 18px 4px" }}>
        <Meter value={filled} tone={tone} label="Scaffold files populated" />
      </div>

      <div className="rows" style={{ marginTop: 8 }}>
        {scaffold.files.map((file) => (
          <div className="row" key={file.file}>
            <div className="row__main">
              <div className="row__title">
                <span className="row__text mono">{file.file}</span>
              </div>
            </div>
            <span className="row__aside">
              {!file.exists ? (
                <Badge tone="bad">missing</Badge>
              ) : !file.populated ? (
                <Badge tone="warn">template</Badge>
              ) : file.lastUpdated ? (
                <span title={`last_updated: ${file.lastUpdated}`}>
                  {formatRelativeTime(`${file.lastUpdated}T00:00:00Z`)}
                </span>
              ) : (
                <Badge tone="good">filled</Badge>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
