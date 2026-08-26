import type { ReactNode } from "react";
import { Banner, Button, Icon } from "../../components/primitives";
import { useCopyToClipboard } from "../../lib/hooks";
import type { SetupMode } from "../../lib/types";

export type JourneyStatus = "pending" | "running" | "done" | "failed" | "locked" | "ready" | "skipped";

export interface JourneyStepState {
  status: JourneyStatus;
  detail?: string | null;
}

/**
 * The four human steps of web setup, in order.
 *
 * The setup job may pack scaffold + graph into one run; this panel is the
 * user-facing sequence so "build the graph" and "paste into your agent" never
 * look like the same moment.
 */
export function SetupJourney(props: {
  mode: SetupMode;
  /** Highlight which step the user should look at now. */
  focus: "scaffold" | "graph" | "populate" | "ground";
  scaffold: JourneyStepState;
  graph: JourneyStepState & {
    onBuild?: () => void;
    building?: boolean;
  };
  populate: JourneyStepState & {
    prompt?: string | null;
    promptLoading?: boolean;
    promptError?: string | null;
  };
  ground: JourneyStepState & {
    children?: ReactNode;
  };
  /** Extra content under the scaffold step (live job checklist). */
  scaffoldExtra?: ReactNode;
  /** Extra content under the graph step (live build progress). */
  graphExtra?: ReactNode;
}) {
  const { mode, focus } = props;
  const codeRepo = mode === "code-repo";
  const steps = codeRepo
    ? ([
        { id: "scaffold" as const, n: 1, title: "Create scaffold", body: <ScaffoldBody state={props.scaffold} extra={props.scaffoldExtra} /> },
        {
          id: "graph" as const,
          n: 2,
          title: "Build code graph",
          body: <GraphBody state={props.graph} extra={props.graphExtra} />,
        },
        {
          id: "populate" as const,
          n: 3,
          title: "Populate with your agent",
          body: <PopulateBody state={props.populate} />,
        },
        {
          id: "ground" as const,
          n: 4,
          title: "Capture grounding",
          body: <GroundBody state={props.ground} />,
        },
      ] as const)
    : ([
        { id: "scaffold" as const, n: 1, title: "Create scaffold", body: <ScaffoldBody state={props.scaffold} extra={props.scaffoldExtra} /> },
        {
          id: "populate" as const,
          n: 2,
          title: "Populate with your agent",
          body: <PopulateBody state={props.populate} />,
        },
      ] as const);

  return (
    <ol className="journey" aria-label="Setup steps">
      {steps.map((step) => {
        const status =
          step.id === "scaffold"
            ? props.scaffold.status
            : step.id === "graph"
              ? props.graph.status
              : step.id === "populate"
                ? props.populate.status
                : props.ground.status;
        const isFocus = focus === step.id;
        return (
          <li
            key={step.id}
            className="journey__step"
            data-status={status}
            data-focus={isFocus ? "true" : "false"}
          >
            <div className="journey__head">
              <span className="journey__num" aria-hidden="true">
                {status === "done" ? Icon.check({ size: 12 }) : step.n}
              </span>
              <div className="journey__title-block">
                <h2 className="journey__title">{step.title}</h2>
                <StatusLabel status={status} />
              </div>
            </div>
            {(isFocus || status === "running" || status === "ready" || status === "failed") && (
              <div className="journey__body">{step.body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StatusLabel(props: { status: JourneyStatus }) {
  const map: Record<JourneyStatus, string> = {
    pending: "Waiting",
    running: "In progress",
    done: "Done",
    failed: "Needs attention",
    locked: "Locked — finish the step above first",
    ready: "Do this next",
    skipped: "Skipped",
  };
  return <span className="journey__status">{map[props.status]}</span>;
}

function ScaffoldBody(props: { state: JourneyStepState; extra?: ReactNode }) {
  return (
    <div className="stack">
      {props.state.detail && <p className="field__help">{props.state.detail}</p>}
      {props.extra}
    </div>
  );
}

function GraphBody(props: {
  state: JourneyStepState & { onBuild?: () => void; building?: boolean };
  extra?: ReactNode;
}) {
  const { state, extra } = props;
  return (
    <div className="stack">
      <p className="field__help">
        mex indexes your source into <code className="mono">.mex/graph.db</code>. Your agent needs
        this before it can write real <code className="mono">grounds_to</code> anchors — without it,
        population can only fill prose.
      </p>
      {state.detail && <p className="dim" style={{ fontSize: "0.84rem" }}>{state.detail}</p>}
      {state.status === "failed" && (
        <Banner tone="bad" title="Code graph didn't finish" icon={Icon.warning()}>
          {state.detail ?? "The graph build failed. Fix the issue below, then build again before pasting the agent prompt."}
        </Banner>
      )}
      {(state.status === "failed" || state.status === "ready" || state.status === "pending") &&
        state.onBuild && (
          <Button variant="primary" onClick={state.onBuild} busy={state.building}>
            {!state.building && Icon.graph()}{" "}
            {state.status === "failed" ? "Retry code graph" : "Build code graph"}
          </Button>
        )}
      {extra}
    </div>
  );
}

function PopulateBody(props: {
  state: JourneyStepState & {
    prompt?: string | null;
    promptLoading?: boolean;
    promptError?: string | null;
  };
}) {
  const { state } = props;
  const { copied, copy } = useCopyToClipboard();

  if (state.status === "locked") {
    return (
      <Banner tone="warn" title="Wait — build the code graph first" icon={Icon.warning()}>
        {state.detail ??
          "Paste the prompt only after step 2 finishes. The agent looks up symbols in graph.db; without it, every grounds_to stays empty."}
      </Banner>
    );
  }

  return (
    <div className="stack">
      <p className="field__help">
        {state.detail ??
          "Copy this prompt, paste it into your coding agent from the project root, and wait until it finishes editing .mex/. Do not skip ahead to capture yet."}
      </p>
      {state.promptError ? (
        <Banner tone="warn" title="Couldn't load the population prompt" icon={Icon.warning()}>
          {state.promptError}
        </Banner>
      ) : state.promptLoading ? (
        <p className="dim">Loading prompt…</p>
      ) : state.prompt ? (
        <>
          <div className="cluster">
            <Button variant="primary" onClick={() => copy(state.prompt!)}>
              {copied ? Icon.check() : Icon.copy()} {copied ? "Copied" : "Copy agent prompt"}
            </Button>
          </div>
          <div className="prompt">
            <pre className="prompt__pre">{state.prompt}</pre>
          </div>
        </>
      ) : null}
    </div>
  );
}

function GroundBody(props: { state: JourneyStepState & { children?: ReactNode } }) {
  if (props.state.status === "locked") {
    return (
      <Banner tone="info" title="After your agent finishes" icon={Icon.link()}>
        {props.state.detail ??
          "When the agent has written grounds_to and mex:// links, come back and capture baselines here. That is what lets mex detect drift."}
      </Banner>
    );
  }

  return <div className="stack">{props.state.children}</div>;
}

/** Preview of the ordered path on the review screen, before anything runs. */
export function SetupPathPreview(props: { mode: SetupMode }) {
  const items =
    props.mode === "code-repo"
      ? [
          { n: 1, title: "Create scaffold", blurb: "Write .mex/ templates and agent instruction files." },
          {
            n: 2,
            title: "Build code graph",
            blurb: "Index source into graph.db — required before the agent can ground claims.",
          },
          {
            n: 3,
            title: "Populate with your agent",
            blurb: "Paste one prompt. The agent fills the wiki and anchors it to real symbols.",
          },
          {
            n: 4,
            title: "Capture grounding",
            blurb: "Record fingerprints so mex can detect when code drifts under the docs.",
          },
        ]
      : [
          { n: 1, title: "Create scaffold", blurb: "Write .mex/ templates and agent instruction files." },
          {
            n: 2,
            title: "Populate with your agent",
            blurb: "Paste one prompt. The agent fills operational memory from your intent.",
          },
        ];

  return (
    <ol className="journey journey--preview" aria-label="What setup will do">
      {items.map((item) => (
        <li key={item.n} className="journey__step" data-status="pending" data-focus="false">
          <div className="journey__head">
            <span className="journey__num">{item.n}</span>
            <div className="journey__title-block">
              <h2 className="journey__title">{item.title}</h2>
              <p className="journey__preview-blurb">{item.blurb}</p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
