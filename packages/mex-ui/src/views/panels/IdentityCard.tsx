import { Badge, Card, Facts, Icon } from "../../components/primitives";
import { formatBytes, formatRelativeTime, truncatePath } from "../../lib/format";
import type { ProjectSnapshot } from "../../lib/types";

const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  copilot: "Copilot",
  opencode: "OpenCode",
  codex: "Codex",
};

export function IdentityCard(props: { snapshot: ProjectSnapshot }) {
  const { snapshot } = props;
  return (
    <Card title="Project" icon={Icon.folder()}>
      <Facts
        items={[
          {
            key: "Root",
            value: (
              <span className="mono" title={snapshot.projectRoot}>
                {truncatePath(snapshot.projectRoot, 40)}
              </span>
            ),
          },
          {
            key: "Git",
            value: snapshot.isGitRepo ? (
              "tracked"
            ) : (
              <span className="dim">not a git repository</span>
            ),
          },
          {
            key: "Identity",
            value: snapshot.identity ? (
              <span className="mono" title={snapshot.identity.scaffold_id}>
                {snapshot.identity.scaffold_id.slice(0, 8)}…
              </span>
            ) : (
              <span className="dim">not minted yet</span>
            ),
          },
          {
            key: "Agents",
            value:
              snapshot.aiTools.length === 0 ? (
                <span className="dim">none configured</span>
              ) : (
                <span className="cluster">
                  {snapshot.aiTools.map((tool) => (
                    <Badge key={tool} tone="neutral">
                      {TOOL_NAMES[tool] ?? tool}
                    </Badge>
                  ))}
                </span>
              ),
          },
          {
            key: "Graph file",
            value: snapshot.graph.present ? (
              `${formatBytes(snapshot.graph.bytes)} · ${formatRelativeTime(snapshot.graph.modifiedAt)}`
            ) : (
              <span className="dim">not built</span>
            ),
          },
          { key: "mex", value: <span className="mono">{snapshot.version}</span> },
        ]}
      />
    </Card>
  );
}
