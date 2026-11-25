import { useEffect, useRef, useState } from "react";
import { useFixtureKnowledge } from "./fixture-knowledge";
import { useFixtureReview } from "./fixture-review";
import { fixtureHomeReview } from "./fixture-review-data";
import { getFixture, type FixtureVariant } from "./fixtures";
import { HubShell } from "./HubShell";
import type { HubJob, JobAction } from "./types";

function updateJob(job: HubJob, action: JobAction): HubJob {
  switch (action) {
    case "pause":
      return job.state.phase === "running" ? { ...job, state: { phase: "running", pausing: true } } : job;
    case "resume":
      return job.state.phase === "paused" ? { ...job, state: { phase: "running" } } : job;
    case "stop":
      return { ...job, state: { phase: "stopped" }, activity: undefined };
    case "reset":
      return { ...job, state: { phase: "queued" }, activity: undefined, progress: undefined };
  }
}

export default function FixtureHub({ variant }: { variant: FixtureVariant }) {
  const [fixture] = useState(() => getFixture(variant));
  const [jobs, setJobs] = useState(fixture.jobs);
  const knowledge = useFixtureKnowledge(fixture.knowledge, fixture.projects, variant);
  const review = useFixtureReview(fixture.review, knowledge, variant);
  const overview = { ...fixture.overview, ...fixtureHomeReview(review.queue) };
  const pauseTimers = useRef(new Set<number>());

  useEffect(() => {
    const timers = pauseTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  function changeJob(id: string, action: JobAction) {
    setJobs((current) => current.map((job) => job.id === id ? updateJob(job, action) : job));
    if (action === "pause") {
      const timer = window.setTimeout(() => {
        pauseTimers.current.delete(timer);
        setJobs((current) => current.map((job) => (
          job.id === id && job.state.phase === "running" && job.state.pausing
            ? { ...job, state: { phase: "paused" } }
            : job
        )));
      }, 800);
      pauseTimers.current.add(timer);
    }
  }

  return (
    <HubShell
      connectionLost={false}
      preview={{ jobs, overview, knowledge, review, changeJob }}
      projects={fixture.projects}
      projectsError={false}
      retryProjects={() => {}}
      session={fixture.session}
    />
  );
}
