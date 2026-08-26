import { Banner, Button, Icon } from "../components/primitives";
import { WelcomeArt } from "./panels/WelcomeArt";
import { api } from "../lib/api";
import { useResource } from "../lib/hooks";
import type { ProjectSnapshot } from "../lib/types";

const STATE_COPY = {
  existing: {
    label: "Existing codebase",
    detail: "Setup will pre-analyze your code so your agent writes the scaffold from what's actually there.",
  },
  partial: {
    label: "Partly documented",
    detail: "Some scaffold files already have real content. Setup fills the empty ones and leaves the rest alone.",
  },
  fresh: {
    label: "Fresh project",
    detail: "There's not much code yet, so your agent will write the scaffold from your intent instead.",
  },
} as const;

const POINTS = [
  {
    label: "Wiki",
    body: "Architecture, stack, conventions, and decisions live in .mex/ as Markdown — versioned with your code.",
  },
  {
    label: "Graph",
    body: "Tree-sitter builds a local SQLite graph so your agent can resolve symbols instead of grepping.",
  },
  {
    label: "Drift",
    body: "mex scores stale claims against the code, so the wiki never quietly rots.",
  },
] as const;

/**
 * The no-`.mex/` state. Its job is to explain what mex will create and get the
 * user into the wizard — not to list features.
 */
export function Welcome(props: { snapshot: ProjectSnapshot; onStartSetup: () => void }) {
  const { snapshot, onStartSetup } = props;
  const plan = useResource(() => api.setupPlan(), []);
  const detected = plan.data ? STATE_COPY[plan.data.state] : null;
  const blocked = plan.data?.isMexRepo === true;

  return (
    <div className="hero">
      <div className="hero__copy">
        <p className="hero__kicker">No .mex/ yet</p>
        <h1 className="hero__title">Give your agent a memory of {snapshot.projectName}</h1>
        <p className="hero__lede">
          mex builds a Markdown wiki and a deterministic code graph in <code className="mono">.mex/</code>, then
          tells you when they stop matching your code. Nothing leaves this machine.
        </p>

        <div className="hero__actions">
          <Button
            variant="primary"
            size="lg"
            onClick={onStartSetup}
            disabled={blocked}
            title={blocked ? "Setup is blocked inside the mex repository" : undefined}
          >
            Set up this project {Icon.arrowRight()}
          </Button>
        </div>

        {blocked && (
          <div className="hero__alert">
            <Banner tone="warn" title="This is the mex repository itself" icon={Icon.warning()}>
              Setup is blocked here because it would overwrite the templates it reads from. Run{" "}
              <code className="mono">mex ui</code> from one of your own projects instead.
            </Banner>
          </div>
        )}

        {detected && !blocked && (
          <p className="hero__meta">
            <span className="hero__meta-label">{detected.label}</span>
            <span className="hero__meta-detail">{detected.detail}</span>
          </p>
        )}

        {!plan.data?.isGitRepo && plan.data && (
          <p className="hero__note">
            No git repository here — mex will use <code className="mono">{plan.data.projectRoot}</code> as the
            project root. Staleness checks need git history, so consider running{" "}
            <code className="mono">git init</code> first.
          </p>
        )}

        <ul className="hero__points">
          {POINTS.map((point) => (
            <li className="hero__point" key={point.label}>
              <span className="hero__point-label">{point.label}</span>
              <span className="hero__point-body">{point.body}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="hero__visual">
        <WelcomeArt />
      </div>
    </div>
  );
}
