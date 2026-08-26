import { Badge, Banner, Button, Card, Icon, Meter, SkeletonRows } from "../../components/primitives";
import { JobProgress } from "./JobProgress";
import { percent, pluralize } from "../../lib/format";
import { useGroundingCapture, useResource } from "../../lib/hooks";
import { api } from "../../lib/api";
import type { GroundingCoverage } from "../../lib/types";

/**
 * The step the web wizard cannot do for you.
 *
 * Grounding is a two-party contract: your agent writes `grounds_to` entries and
 * `mex://` anchors into `.mex/`, then mex fingerprints the code each one points
 * at. Drift detection compares against those fingerprints, so grounding that was
 * authored but never captured is documentation mex silently cannot verify.
 *
 * `mex setup` in a terminal captures baselines the moment its agent session
 * ends. The browser has no agent session to wait on, so this panel exists to
 * close the loop once you've run the population prompt.
 */
export function GroundingCapture(props: {
  /** Called after a successful capture so drift and the snapshot can refresh. */
  onCaptured?: () => void;
}) {
  const { onCaptured } = props;
  const coverage = useResource(() => api.grounding(), []);
  const capture = useGroundingCapture(() => {
    coverage.reload();
    onCaptured?.();
  });

  const data = coverage.data;

  return (
    <Card
      title="Grounding baselines"
      icon={Icon.link()}
      hint="What lets mex tell you when the code moves out from under your docs"
      actions={
        data && data.authored > 0 ? (
          <span className="dim tabular" style={{ fontSize: "0.8rem" }}>
            {data.captured}/{data.authored} captured
          </span>
        ) : undefined
      }
    >
      <div className="stack">
        {coverage.loading ? (
          <SkeletonRows rows={2} />
        ) : coverage.error ? (
          <Banner tone="warn" title="Couldn't read grounding coverage" icon={Icon.warning()}>
            {coverage.error.message}
          </Banner>
        ) : data ? (
          <CoverageBody coverage={data} />
        ) : null}

        {capture.job && (
          <JobProgress
            job={capture.job}
            title={capture.job.status === "succeeded" ? "Capture finished" : "Capturing grounding"}
            pendingLabel="Starting capture…"
          />
        )}

        {capture.result && <CaptureOutcome result={capture.result} />}

        {capture.error && (
          <Banner tone="bad" title="Capture failed" icon={Icon.warning()}>
            {capture.error}
          </Banner>
        )}

        <div className="cluster">
          <Button
            variant={data?.needsCapture ? "primary" : "default"}
            onClick={capture.capture}
            busy={capture.capturing}
            disabled={data !== null && !data.graphAvailable}
            title={
              data !== null && !data.graphAvailable
                ? "Build the code graph first — baselines are fingerprints of real code."
                : undefined
            }
          >
            {!capture.capturing && Icon.link()} My agent has finished — capture grounding
          </Button>
          {!coverage.loading && (
            <Button variant="ghost" size="sm" onClick={coverage.reload} busy={coverage.refreshing}>
              {Icon.refresh()} Re-check
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function CoverageBody(props: { coverage: GroundingCoverage }) {
  const { coverage } = props;

  if (coverage.error) {
    return (
      <Banner tone="warn" title="The graph couldn't be read" icon={Icon.warning()}>
        {coverage.error}
      </Banner>
    );
  }

  if (!coverage.graphAvailable) {
    return (
      <Banner tone="info" title="No code graph yet" icon={Icon.graph()}>
        Baselines are fingerprints of real code, so the graph has to exist before grounding can be
        captured. Build it first, then come back here.
      </Banner>
    );
  }

  if (coverage.authored === 0) {
    return (
      <Banner tone="info" title="No grounding authored yet" icon={Icon.doc()}>
        Nothing in <code className="mono">.mex/</code> points at a symbol yet. Run the population
        prompt in your agent — it is asked to add <code className="mono">grounds_to</code> entries and{" "}
        <code className="mono">mex://</code> anchors — then capture.
      </Banner>
    );
  }

  const complete = coverage.captured >= coverage.authored;

  return (
    <div className="stack">
      <Meter
        value={percent(coverage.captured, coverage.authored)}
        tone={complete ? "good" : coverage.captured === 0 ? "bad" : "warn"}
        label="Grounding references with a captured baseline"
      />
      <p className="field__help">
        {complete
          ? `Every one of the ${pluralize(coverage.authored, "grounding reference")} in your scaffold has a baseline. Drift detection can verify all of them.`
          : `${coverage.authored - coverage.captured} of ${coverage.authored} grounding references have no baseline, so mex can't tell you when the code behind them changes.`}
      </p>

      {coverage.files.length > 0 && (
        <div className="rows">
          {coverage.files.map((file) => (
            <div className="row" key={file.file}>
              <div className="row__main">
                <div className="row__title">
                  <span className="row__text mono">{file.file}</span>
                </div>
              </div>
              <span className="row__aside tabular">
                {file.captured === file.authored ? (
                  <Badge tone="good">{file.authored} grounded</Badge>
                ) : (
                  <Badge tone={file.captured === 0 ? "bad" : "warn"}>
                    {file.captured}/{file.authored} captured
                  </Badge>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Say what actually happened. Zero captured after a successful job is the
 * interesting case — the job worked and found nothing to record — and reporting
 * it as success would teach the user to trust a signal that isn't there.
 */
function CaptureOutcome(props: { result: { captured: number; skipped: number } }) {
  const { captured, skipped } = props.result;

  if (captured === 0 && skipped === 0) {
    return (
      <Banner tone="warn" title="Nothing to capture" icon={Icon.warning()}>
        No <code className="mono">grounds_to</code> entries or <code className="mono">mex://</code>{" "}
        anchors were found in <code className="mono">.mex/</code>. Your agent wrote prose but no
        grounding — ask it to anchor its claims to the symbols they describe, then capture again.
      </Banner>
    );
  }

  if (captured === 0) {
    return (
      <Banner tone="warn" title={`${pluralize(skipped, "reference")} skipped`} icon={Icon.warning()}>
        Every reference pointed at something the graph doesn't have — usually a hand-written or
        hallucinated symbol id. The job log above names each one.
      </Banner>
    );
  }

  return (
    <Banner tone="good" title={`${pluralize(captured, "baseline")} captured`} icon={Icon.check()}>
      Drift detection can now verify {captured === 1 ? "that claim" : "those claims"} against the
      code.
      {skipped > 0 &&
        ` ${pluralize(skipped, "reference")} ${skipped === 1 ? "was" : "were"} skipped — see the log above.`}
    </Banner>
  );
}
