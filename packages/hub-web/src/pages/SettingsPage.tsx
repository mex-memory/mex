import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BellRing, Compass, NotebookPen } from "lucide-react";
import { Link } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import { useHubOnboarding } from "../app/HubOnboarding";
import type { AgentLoggingMode, AgentLoggingPolicy } from "../api/types";
import { Button } from "../components/primitives/button";
import { ErrorState, PageHeader, StatePanel } from "../components/ui";
import styles from "../styles/settings.module.css";

const QUERY_KEY = ["settings", "logging"] as const;
const DRIFT_ALERTS_QUERY_KEY = ["settings", "drift-alerts"] as const;
const MODES: { mode: AgentLoggingMode; title: string; description: string }[] = [
  { mode: "significant", title: "Significant events", description: "Record decisions, discoveries, and risks worth remembering. Skip routine progress." },
  { mode: "checkpoints", title: "Task checkpoints", description: "Gather useful notes into one entry when a task or session ends." },
  { mode: "manual", title: "Only when asked", description: "Write a project note when you explicitly ask the agent to save one." },
];

function LoggingPreference({ policy }: { policy: AgentLoggingPolicy }) {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<AgentLoggingMode | null>(null);
  const [saved, setSaved] = useState(false);
  const savedNotice = useRef<HTMLParagraphElement>(null);
  const mode = selected ?? policy.mode;
  const save = useMutation({
    mutationFn: () => api.setLoggingPolicy({ mode, expectedRevision: policy.revision }),
    onMutate: () => queryClient.cancelQueries({ queryKey: QUERY_KEY }),
    onSuccess: async (next) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData(QUERY_KEY, next);
      setSelected(null);
      setSaved(true);
    },
  });
  useEffect(() => { if (saved) savedNotice.current?.focus(); }, [saved]);
  const conflict = save.error instanceof HubApiError && save.error.problem.code === "REVISION_CONFLICT";

  return (
    <section className={styles.surface} aria-labelledby="logging-title">
      <div className={styles.intro}>
        <span className={styles.icon}><NotebookPen aria-hidden="true" /></span>
        <div><h2 id="logging-title">Agent logging</h2><p>Keep the useful context. Choose when agents add project notes.</p></div>
        <span className={styles.scope}>This checkout</span>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (mode !== policy.mode && !save.isPending && !save.isError) save.mutate(); }}>
        <fieldset className={styles.choices} disabled={save.isPending}>
          <legend>When to write notes</legend>
          {MODES.map((choice) => (
            <label key={choice.mode} className={styles.choice} data-selected={mode === choice.mode}>
              <input type="radio" name="logging-mode" value={choice.mode} checked={mode === choice.mode}
                aria-label={choice.title}
                aria-describedby={`logging-${choice.mode}-description`}
                onChange={() => { setSelected(choice.mode); setSaved(false); }} />
              <span><strong>{choice.title}{choice.mode === "significant" ? <small>Default</small> : null}</strong>
                <span id={`logging-${choice.mode}-description`}>{choice.description}</span></span>
            </label>
          ))}
        </fieldset>
        <div className={styles.footer}>
          <p>Saved on this device for this checkout. Teammates keep their own preference.</p>
          <div className={styles.actions}>
            {selected !== null && mode !== policy.mode ? <Button type="button" variant="ghost" size="sm" disabled={save.isPending}
              onClick={() => { setSelected(null); setSaved(false); }}>Cancel</Button> : null}
            <Button type="submit" size="sm" disabled={mode === policy.mode || save.isPending || save.isError}>{save.isPending ? "Saving…" : "Save preference"}</Button>
          </div>
        </div>
        {saved ? <p ref={savedNotice} tabIndex={-1} role="status" className={styles.saved}>Logging preference saved for this checkout.</p> : null}
        {save.isError ? <div className={styles.error} role="alert">
          <p>{conflict ? "The logging preference changed in another session. Reload it before saving again."
            : "The save could not be confirmed. Reload the preference before trying again."}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            setSelected(null); save.reset(); void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
          }}>Reload preference</Button>
        </div> : null}
      </form>
      <div className={styles.explanation}>
        <p>This guides agents using the MEX instructions when they start a session. Explicit requests to save a note are always honored. Team workflow history is recorded independently.</p>
        <Link to="/activity?source=legacy">Read project notes in Activity <ArrowUpRight aria-hidden="true" /></Link>
      </div>
    </section>
  );
}

function DriftAlertPreference() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: DRIFT_ALERTS_QUERY_KEY, queryFn: () => api.getDriftAlerts(), staleTime: 0 });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setDriftAlerts({ enabled }),
    onSuccess: (next) => queryClient.setQueryData(DRIFT_ALERTS_QUERY_KEY, next),
  });
  if (alerts.isPending) return <StatePanel state="loading" title="Loading drift alerts" detail="Reading this checkout’s drift alert setting." />;
  if (alerts.isError) return <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />;
  const { enabled, commitHook, lastDelivery } = alerts.data;
  return (
    <section className={styles.surface} aria-labelledby="drift-alerts-title">
      <div className={styles.intro}>
        <span className={styles.icon}><BellRing aria-hidden="true" /></span>
        <div><h2 id="drift-alerts-title">Drift alerts</h2><p>Get a desktop notification when knowledge may be out of date and <code>mex sync</code> has work to do.</p></div>
        <span className={styles.scope}>This checkout</span>
      </div>
      <fieldset className={styles.choices} disabled={save.isPending}>
        <label className={styles.choice} data-selected={enabled}>
          <input type="checkbox" checked={enabled} aria-describedby="drift-alerts-description"
            onChange={(event) => save.mutate(event.target.checked)} />
          <span><strong>Notify me about drift</strong>
            <span id="drift-alerts-description">Checks run on this computer. They start no agent and change no knowledge.</span></span>
        </label>
      </fieldset>
      {save.isError ? <div className={styles.error} role="alert"><p>The setting could not be saved. Try again.</p></div> : null}
      {enabled && lastDelivery === "failed" ? <div className={styles.error} role="alert">
        <p>The last notification could not be shown. Check this computer’s notification settings. Overview still shows drift.</p>
      </div> : null}
      <div className={styles.explanation}>
        <p>
          {enabled && commitHook ? "Checks run while Hub or mex watch --interval is open, and after each commit."
            : enabled ? "Checks run while Hub or mex watch --interval is open."
              : "In a Git repository, turning this on adds a small block to this checkout’s post-commit hook so a commit also starts a check. Turning it off removes that block."}
        </p>
      </div>
    </section>
  );
}

function OnboardingPreference() {
  const onboarding = useHubOnboarding();
  if (onboarding === null) return null;
  return (
    <section className={styles.surface} aria-labelledby="onboarding-title">
      <div className={styles.intro}>
        <span className={styles.icon}><Compass aria-hidden="true" /></span>
        <div>
          <h2 id="onboarding-title">Hub tour</h2>
          <p>The first-run walkthrough of Context, Code, Inbox, Relays, and Health.</p>
        </div>
        <span className={styles.scope}>This checkout</span>
      </div>
      <div className={styles.footer}>
        <p>Shown once in this checkout. Teammates see it in their own checkouts.</p>
        <div className={styles.actions}>
          <Button onClick={() => onboarding.replay()} size="sm" type="button" variant="outline">
            Replay Hub tour
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const api = useHubApi();
  const policy = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.getLoggingPolicy(), staleTime: 0 });
  return (
    <div className={styles.page}>
      <PageHeader title="Settings" description="Preferences for this checkout." />
      <div className={styles.stack}>
        <OnboardingPreference />
        <DriftAlertPreference />
        {policy.isPending ? <StatePanel state="loading" title="Loading preferences" detail="Reading this checkout’s agent logging policy." />
          : policy.isError ? <ErrorState error={policy.error} retry={() => void policy.refetch()} />
            : <LoggingPreference policy={policy.data} />}
      </div>
    </div>
  );
}
