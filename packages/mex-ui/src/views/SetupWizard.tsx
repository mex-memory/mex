import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  ErrorState,
  Facts,
  Icon,
  OptionCard,
  SkeletonRows,
} from "../components/primitives";
import { GroundingCapture } from "./panels/GroundingCapture";
import { JobProgress } from "./panels/JobProgress";
import { SetupJourney, SetupPathPreview } from "./panels/SetupJourney";
import { ApiError, api } from "../lib/api";
import { useGraphBuild, useJobProgress, useResource } from "../lib/hooks";
import { pluralize } from "../lib/format";
import type { AiTool, Job, ProjectSnapshot, SetupMode, SetupResult } from "../lib/types";

type Phase = "project" | "agent" | "review" | "run";

const PHASES: Array<{ id: Phase; label: string }> = [
  { id: "project", label: "Project" },
  { id: "agent", label: "Agent" },
  { id: "review", label: "Review" },
  { id: "run", label: "Run" },
];

const TOOLS: Array<{ id: AiTool; name: string; file: string }> = [
  { id: "claude", name: "Claude Code", file: "CLAUDE.md" },
  { id: "cursor", name: "Cursor", file: ".cursorrules" },
  { id: "codex", name: "Codex", file: "AGENTS.md" },
  { id: "copilot", name: "GitHub Copilot", file: ".github/copilot-instructions.md" },
  { id: "windsurf", name: "Windsurf", file: ".windsurfrules" },
  { id: "opencode", name: "OpenCode", file: ".opencode/opencode.json" },
];

const STATE_LABEL = {
  existing: "Existing codebase",
  partial: "Partly documented",
  fresh: "Fresh project",
} as const;

/**
 * Zero to a working `.mex/` in ordered steps: scaffold → graph → agent → ground.
 * Choices have defaults; Continue three times starts the path. Graph is not optional
 * for code-repo — population is locked until it exists.
 */
export function SetupWizard(props: {
  snapshot: ProjectSnapshot;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const { snapshot, onFinish, onCancel } = props;
  const plan = useResource(() => api.setupPlan(), []);

  const [phase, setPhase] = useState<Phase>("project");
  const [mode, setMode] = useState<SetupMode>("code-repo");
  const [tools, setTools] = useState<AiTool[]>(() => (snapshot.aiTools.length ? snapshot.aiTools : ["claude"]));
  const [jobId, setJobId] = useState<string | null>(null);
  const [seedJob, setSeedJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);

  const { job } = useJobProgress(jobId, seedJob);
  const result = job?.status === "succeeded" ? (job.result as SetupResult | null) : null;

  const toggleTool = useCallback((tool: AiTool) => {
    setTools((current) =>
      current.includes(tool) ? current.filter((entry) => entry !== tool) : [...current, tool],
    );
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      // Code-repo always builds the graph in this job — population depends on it.
      const started = await api.startSetup({
        mode,
        tools,
        buildGraph: mode === "code-repo",
      });
      setSeedJob(started);
      setJobId(started.id);
      setPhase("run");
    } catch (error) {
      setStartError(
        error instanceof ApiError
          ? error
          : new ApiError(String(error), { code: "UNKNOWN", status: 0 }),
      );
    } finally {
      setStarting(false);
    }
  }, [mode, tools]);

  const currentIndex = PHASES.findIndex((entry) => entry.id === phase);

  if (plan.loading) {
    return (
      <div className="wizard">
        <Card title="Inspecting project">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  if (plan.error || !plan.data) {
    return (
      <div className="wizard">
        <Card>
          <ErrorState
            title="Couldn't inspect this project"
            message={plan.error?.message ?? "No setup plan was returned."}
            onRetry={plan.reload}
          />
        </Card>
      </div>
    );
  }

  if (plan.data.isMexRepo) {
    return (
      <div className="wizard">
        <Banner tone="warn" title="Setup is blocked in the mex repository" icon={Icon.warning()}>
          Scaffolding mex with mex would overwrite the templates setup reads from. Run{" "}
          <code className="mono">mex ui</code> from one of your own projects instead.
        </Banner>
        <div>
          <Button onClick={onCancel}>{Icon.arrowLeft()} Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="page-head__text">
          <h1>Set up {plan.data.projectName}</h1>
          <p className="page-head__sub">
            mex will create <code className="mono">.mex/</code> in{" "}
            <code className="mono">{plan.data.projectRoot}</code>
          </p>
        </div>
      </div>

      <PhaseRail current={currentIndex} />

      {phase === "project" && (
        <Card title="What kind of project is this?" icon={Icon.folder()}>
          <div className="stack">
            <Banner
              tone="info"
              title={`Detected: ${STATE_LABEL[plan.data.state]}`}
              icon={Icon.spark()}
            >
              {plan.data.state === "existing" &&
                "mex will pre-analyze your code so your agent writes the scaffold from what's actually there."}
              {plan.data.state === "partial" &&
                "Some scaffold files already hold real content. They will be left exactly as they are."}
              {plan.data.state === "fresh" &&
                "There isn't much code yet, so your agent will write the scaffold from your intent."}
            </Banner>

            <fieldset className="fieldset">
              <legend className="field__label">Template set</legend>
              <div className="options">
                <OptionCard
                  kind="radio"
                  name="mode"
                  selected={mode === "code-repo"}
                  onSelect={() => setMode("code-repo")}
                  title={
                    <>
                      Code repository <Badge tone="neutral">recommended</Badge>
                    </>
                  }
                  description="A wiki plus a code graph for a codebase your agent works in."
                />
                <OptionCard
                  kind="radio"
                  name="mode"
                  selected={mode === "agent-memory"}
                  onSelect={() => setMode("agent-memory")}
                  title="Agent memory workspace"
                  description="Operational memory for a long-running agent, with a heartbeat file and no code graph."
                />
              </div>
            </fieldset>
          </div>
        </Card>
      )}

      {phase === "agent" && (
        <Card title="Which agents work in this project?" icon={Icon.plug()}>
          <div className="stack">
            <p className="field__help">
              mex writes a short instructions file for each one, pointing it at{" "}
              <code className="mono">.mex/ROUTER.md</code>. An existing file is never overwritten. You can
              also select none — <code className="mono">.mex/AGENTS.md</code> works with any agent that reads
              files.
            </p>
            <div className="options options--grid">
              {TOOLS.map((tool) => (
                <OptionCard
                  key={tool.id}
                  kind="check"
                  selected={tools.includes(tool.id)}
                  onSelect={() => toggleTool(tool.id)}
                  title={tool.name}
                  description={<code className="mono">{tool.file}</code>}
                />
              ))}
            </div>
          </div>
        </Card>
      )}

      {phase === "review" && (
        <Card title="Ready to start" icon={Icon.check()}>
          <div className="stack">
            <Facts
              items={[
                { key: "Location", value: <span className="mono">{plan.data.projectRoot}/.mex</span> },
                {
                  key: "Template",
                  value: mode === "code-repo" ? "Code repository" : "Agent memory workspace",
                },
                {
                  key: "Files",
                  value: `${pluralize(plan.data.scaffoldFiles.length, "scaffold file")}${
                    plan.data.hasScaffold ? " — already-populated files are kept" : ""
                  }`,
                },
                {
                  key: "Agents",
                  value:
                    tools.length === 0 ? (
                      <span className="dim">none selected</span>
                    ) : (
                      <span className="cluster">
                        {tools.map((tool) => (
                          <Badge key={tool} tone="neutral">
                            {TOOLS.find((entry) => entry.id === tool)?.name ?? tool}
                          </Badge>
                        ))}
                      </span>
                    ),
                },
              ]}
            />

            <div>
              <p className="field__label" style={{ marginBottom: 10 }}>
                What happens, in order
              </p>
              <SetupPathPreview mode={mode} />
            </div>

            {mode === "code-repo" && (
              <Banner tone="info" title="Do not paste the agent prompt early" icon={Icon.terminal()}>
                Steps 1 and 2 run first (scaffold + code graph). Only after the graph is done will
                step 3 unlock the prompt — that is how grounding stays real.
              </Banner>
            )}

            {startError && (
              <Banner tone="bad" title="Setup couldn't start" icon={Icon.warning()}>
                {startError.message}
              </Banner>
            )}

            <p className="dim" style={{ fontSize: "0.84rem" }}>
              This writes only inside your project: <code className="mono">.mex/</code> plus the agent
              instruction files you picked. Nothing is sent anywhere.
            </p>
          </div>
        </Card>
      )}

      {phase === "run" && <RunPhase job={job} result={result} mode={mode} onFinish={onFinish} />}

      {phase !== "run" && (
        <div className="cluster">
          <Button
            onClick={() => (currentIndex === 0 ? onCancel() : setPhase(PHASES[currentIndex - 1].id))}
          >
            {Icon.arrowLeft()} {currentIndex === 0 ? "Cancel" : "Back"}
          </Button>
          <div style={{ flex: 1 }} />
          {phase === "review" ? (
            <Button variant="primary" onClick={start} busy={starting}>
              {!starting && Icon.spark()} Start setup
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setPhase(PHASES[currentIndex + 1].id)}>
              Continue {Icon.arrowRight()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseRail(props: { current: number }) {
  return (
    <nav className="wizard__rail" aria-label="Setup progress">
      {PHASES.map((phase, index) => (
        <div key={phase.id} className="cluster" style={{ gap: 8 }}>
          {index > 0 && <span className="wizard__rail-sep" aria-hidden="true" />}
          <span
            className="wizard__rail-item"
            data-state={index === props.current ? "current" : index < props.current ? "done" : "todo"}
            aria-current={index === props.current ? "step" : undefined}
          >
            <span className="wizard__rail-num">
              {index < props.current ? Icon.check({ size: 10 }) : index + 1}
            </span>
            {phase.label}
          </span>
        </div>
      ))}
    </nav>
  );
}

/**
 * Live journey after Start: scaffold and graph run in the job; populate and
 * ground unlock only when their prerequisites are met.
 */
function RunPhase(props: {
  job: Job | null;
  result: SetupResult | null;
  mode: SetupMode;
  onFinish: () => void;
}) {
  const { job, result, mode, onFinish } = props;
  const codeRepo = mode === "code-repo";

  const graphRetry = useGraphBuild();
  const graphFromSetup = Boolean(result?.graph) && !result?.graphError;
  const graphRetryDone = graphRetry.job?.status === "succeeded";
  const graphReady = graphFromSetup || graphRetryDone;
  const graphFailed =
    Boolean(result?.graphError) || graphRetry.job?.status === "failed" || Boolean(graphRetry.buildError);
  const graphRunning =
    job?.status === "running" ||
    graphRetry.building ||
    graphRetry.job?.status === "running";

  const focus = useMemo(() => {
    if (!result) {
      if (job?.status === "running") {
        const graphStep = job.steps.find((step) => step.id === "graph");
        if (graphStep && (graphStep.status === "running" || graphStep.status === "pending")) {
          // Still on early steps or actively building graph.
          const early = job.steps.find(
            (step) =>
              ["detect", "scaffold", "tools", "identity", "scan"].includes(step.id) &&
              (step.status === "running" || step.status === "pending"),
          );
          if (early && graphStep.status === "pending") return "scaffold" as const;
          return "graph" as const;
        }
        return "scaffold" as const;
      }
      return "scaffold" as const;
    }
    if (codeRepo && !graphReady) return "graph" as const;
    return "populate" as const;
  }, [codeRepo, graphReady, job, result]);

  const scaffoldStatus =
    !job || job.status === "running"
      ? ("running" as const)
      : job.status === "failed"
        ? ("failed" as const)
        : result
          ? ("done" as const)
          : ("pending" as const);

  const graphStatus = !codeRepo
    ? ("skipped" as const)
    : graphReady
      ? ("done" as const)
      : graphRunning && result
        ? ("running" as const)
        : graphRunning && !result
          ? job?.steps.find((s) => s.id === "graph")?.status === "running"
            ? ("running" as const)
            : ("pending" as const)
          : graphFailed
            ? ("failed" as const)
            : result
              ? ("ready" as const)
              : ("pending" as const);

  const populateStatus =
    !result || (codeRepo && !graphReady)
      ? ("locked" as const)
      : ("ready" as const);

  const groundStatus =
    !result || (codeRepo && !graphReady) ? ("locked" as const) : ("ready" as const);

  const graphDetail = graphReady
    ? result?.graph
      ? `${result.graph.nodesCreated.toLocaleString()} nodes across ${result.graph.filesIndexed.toLocaleString()} files`
      : "Code graph is ready."
    : graphRetry.buildError ||
      result?.graphError ||
      (graphRunning ? "Indexing source…" : null);

  return (
    <div className="stack">
      {job?.status === "failed" && (
        <Banner tone="bad" title="Setup didn't finish" icon={Icon.warning()}>
          {job.error ?? "The setup job failed."} Nothing was partially written that a re-run won't fix —
          setup never overwrites populated files.
        </Banner>
      )}

      {job && (job.status === "running" || (!result && job.status !== "failed")) && (
        <JobProgress
          job={job}
          title={focus === "graph" ? "Step 2 — building code graph" : "Step 1 — creating scaffold"}
          pendingLabel="Starting setup…"
        />
      )}

      <SetupJourney
        mode={mode}
        focus={focus}
        scaffold={{
          status: scaffoldStatus,
          detail:
            scaffoldStatus === "done"
              ? "Templates and agent instruction files are on disk."
              : scaffoldStatus === "running"
                ? "Writing .mex/ and preparing the project…"
                : null,
        }}
        graph={{
          status: graphStatus,
          detail: graphDetail,
          onBuild: codeRepo && result && !graphReady ? () => void graphRetry.startBuild() : undefined,
          building: graphRetry.building,
        }}
        populate={{
          status: populateStatus,
          prompt: populateStatus === "ready" ? result?.prompt ?? null : null,
          detail:
            populateStatus === "locked"
              ? "Unlocks after the code graph finishes. Pasting early leaves every grounds_to empty."
              : "Paste into your coding agent from the project root. Come back when it finishes — then capture grounding below.",
        }}
        ground={{
          status: groundStatus,
          detail:
            groundStatus === "locked"
              ? "Unlocks after the graph is ready. Run it only after your agent has authored grounds_to."
              : undefined,
          children: result && codeRepo && graphReady ? <GroundingCapture /> : undefined,
        }}
        graphExtra={
          graphRetry.job ? (
            <JobProgress
              job={graphRetry.job}
              title={graphRetry.job.status === "succeeded" ? "Graph built" : "Building code graph"}
              pendingLabel="Starting graph build…"
            />
          ) : null
        }
      />

      <div className="cluster">
        <div style={{ flex: 1 }} />
        <Button variant={result && (!codeRepo || graphReady) ? "default" : "ghost"} onClick={onFinish}>
          {result ? "Open dashboard" : "Back to dashboard"} {Icon.arrowRight()}
        </Button>
      </div>
    </div>
  );
}
