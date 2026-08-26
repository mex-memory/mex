import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, jobStreamUrl } from "./api";
import type { GroundingCaptureResult, Job } from "./types";

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  /** True only for the first load, so a refresh doesn't blank the view. */
  loading: boolean;
  /** True while a background refresh is in flight over existing data. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Load an API resource, keeping the previous value visible while refetching.
 * Views get four distinct states — loading, error, empty, loaded — instead of
 * having to infer them from a nullable value.
 */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Held in a ref so changing the loader identity between renders (an inline
  // arrow, in practice) never restarts the fetch — only `deps` and `reload` do.
  const loadRef = useRef(load);
  loadRef.current = load;

  const hasData = data !== null;

  useEffect(() => {
    let active = true;
    if (hasData) setRefreshing(true);
    else setLoading(true);

    loadRef.current().then(
      (value) => {
        if (!active) return;
        setData(value);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(cause instanceof Error ? cause.message : String(cause), {
                code: "UNKNOWN",
                status: 0,
              }),
        );
        setLoading(false);
        setRefreshing(false);
      },
    );

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, loading, refreshing, reload };
}

const JOB_POLL_INTERVAL_MS = 1200;

export interface JobTracker {
  job: Job | null;
  /** Set when progress could not be followed at all. */
  error: string | null;
}

/**
 * Follow a job to completion over server-sent events, falling back to polling
 * if the stream can't be established. Progress must survive an unreliable
 * connection: a wizard that silently stops updating mid-setup is worse than a
 * slow one.
 */
export function useJobProgress(jobId: string | null, seed: Job | null = null): JobTracker {
  const [job, setJob] = useState<Job | null>(seed);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Keep the POST snapshot on screen until the stream delivers a newer one.
    // Clearing to null here is what produced a 30-minute "Starting setup…"
    // spinner: the job was running, but the first frame had been thrown away.
    setJob(seed);
    setError(null);
    if (!jobId) return;

    let active = true;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let latest: Job | null = null;

    const stop = () => {
      source?.close();
      source = null;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
    };

    const accept = (next: Job) => {
      if (!active) return;
      latest = next;
      setJob(next);
      if (next.status !== "running") stop();
    };

    const poll = () => {
      if (!active) return;
      api.job(jobId).then(
        (next) => {
          accept(next);
          if (active && next.status === "running") {
            pollTimer = setTimeout(poll, JOB_POLL_INTERVAL_MS);
          }
        },
        (cause: unknown) => {
          if (!active) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };

    if (typeof EventSource === "undefined") {
      poll();
      return () => {
        active = false;
        stop();
      };
    }

    source = new EventSource(jobStreamUrl(jobId));
    source.addEventListener("job", (event) => {
      try {
        accept(JSON.parse((event as MessageEvent<string>).data) as Job);
      } catch {
        setError("Received malformed progress data from the server.");
      }
    });
    source.addEventListener("error", () => {
      // The server closes the stream on completion, which surfaces here as an
      // error too. Only fall back to polling if the job is still unfinished.
      source?.close();
      source = null;
      if (!active) return;
      if (latest === null || latest.status === "running") poll();
    });

    return () => {
      active = false;
      stop();
    };
  }, [jobId, seed]);

  return { job, error };
}

/**
 * Minimal history-API router. The server serves index.html for any path, so
 * reloading inside the wizard returns to the wizard.
 */
export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0 });
  }, []);

  return { path, navigate };
}

/**
 * Graph build lives above the current view so starting it from Dashboard and
 * then opening Graph still shows the same job.
 */
export function useGraphBuild(onSettled?: () => void): {
  job: Job | null;
  building: boolean;
  buildError: string | null;
  startBuild: () => Promise<void>;
} {
  const [jobId, setJobId] = useState<string | null>(null);
  const [seed, setSeed] = useState<Job | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const { job } = useJobProgress(jobId, seed);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const startBuild = useCallback(async () => {
    setBuilding(true);
    setBuildError(null);
    try {
      const started = await api.startGraphBuild();
      setSeed(started);
      setJobId(started.id);
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : String(error));
      setBuilding(false);
    }
  }, []);

  useEffect(() => {
    if (!job || job.status === "running") return;
    setBuilding(false);
    if (job.status === "failed") {
      setBuildError(job.error);
      return;
    }
    onSettledRef.current?.();
  }, [job?.status]);

  return { job, building, buildError, startBuild };
}

export interface GroundingCaptureTracker {
  job: Job | null;
  result: GroundingCaptureResult | null;
  capturing: boolean;
  error: string | null;
  capture: () => Promise<void>;
}

/**
 * Record baselines for grounding an agent has authored. Separate from
 * {@link useGraphBuild} because the two are ordered — capture only means
 * anything once a graph exists — and the UI reports them independently.
 */
export function useGroundingCapture(onSettled?: () => void): GroundingCaptureTracker {
  const [jobId, setJobId] = useState<string | null>(null);
  const [seed, setSeed] = useState<Job | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job } = useJobProgress(jobId, seed);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const capture = useCallback(async () => {
    setCapturing(true);
    setError(null);
    try {
      const started = await api.startGroundingCapture();
      setSeed(started);
      setJobId(started.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCapturing(false);
    }
  }, []);

  useEffect(() => {
    if (!job || job.status === "running") return;
    setCapturing(false);
    if (job.status === "failed") {
      setError(job.error);
      return;
    }
    onSettledRef.current?.();
  }, [job?.status]);

  return {
    job,
    result: job?.status === "succeeded" ? (job.result as GroundingCaptureResult | null) : null,
    capturing,
    error,
    capture,
  };
}

/** Copy to clipboard, reporting success for ~2s so the button can confirm. */
export function useCopyToClipboard(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback((text: string) => {
    const confirm = () => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    };

    // navigator.clipboard needs a secure context; http://localhost qualifies,
    // but http://127.0.0.1 in some browsers does not — hence the fallback.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(confirm, () => fallbackCopy(text, confirm));
      return;
    }
    fallbackCopy(text, confirm);
  }, []);

  return { copied, copy };
}

function fallbackCopy(text: string, onSuccess: () => void): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (document.execCommand("copy")) onSuccess();
  } catch {
    // Nothing more we can do — the prompt is selectable in the page.
  } finally {
    document.body.removeChild(textarea);
  }
}
