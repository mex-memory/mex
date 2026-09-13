import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { HubApiError, type HubApi } from "../api/client";
import type { SetupCommitPreview, SetupCommitResponse } from "../api/types";
import { Button } from "../components/primitives/button";
import { Textarea } from "../components/primitives/textarea";
import { SetupCommitDiff } from "./SetupCommitDiff";
import { parseSetupDiff, type SetupDiff } from "./setup-commit-diff";
import styles from "../styles/setup.module.css";

type CommitApi = Pick<HubApi, "previewSetupCommit" | "commitSetup" | "setupCommitDiff">;
/** Diffs load when a file is first expanded, so review size no longer bounds one response. */
type LoadedDiff =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "loaded"; diff: string; parsed: SetupDiff };

export function SetupCommitReview({ api, onCommitted, onReviewInvalid, onOpenHub, opening = false }: {
  api: CommitApi;
  onCommitted: (response: SetupCommitResponse) => void;
  onReviewInvalid: () => void;
  onOpenHub: () => void;
  opening?: boolean;
}) {
  const [preview, setPreview] = useState<SetupCommitPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [diffs, setDiffs] = useState<Map<string, LoadedDiff>>(() => new Map());
  const [attempted, setAttempted] = useState(false);
  const revision = useRef<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [committed, setCommitted] = useState<SetupCommitResponse | null>(null);
  const inFlight = useRef(false);

  const review = useMutation({
    mutationFn: () => {
      if (!api.previewSetupCommit) throw new Error("Setup review is unavailable.");
      return api.previewSetupCommit();
    },
    onMutate: () => { setAttempted(true); setPreview(null); revision.current = null; },
    onSuccess: (next) => {
      revision.current = next.revision;
      setPreview(next);
      setMessage((current) => current ?? next.defaultMessage);
      setViewed(new Set());
      setExpanded(new Set());
      setDiffs(new Map());
      setExpired(Date.parse(next.expiresAt) <= Date.now());
      commit.reset();
    },
  });
  const commit = useMutation({
    mutationFn: ({ revision, message: commitMessage }: { revision: string; message: string }) => {
      if (!api.commitSetup) throw new Error("Setup commit is unavailable.");
      return api.commitSetup({ revision, message: commitMessage });
    },
    onSuccess: (response) => {
      setCommitted(response);
      setPreview(null);
      onCommitted(response);
    },
    onError: () => {
      setPreview(null);
      onReviewInvalid();
    },
    onSettled: () => { inFlight.current = false; },
  });

  useEffect(() => {
    if (!preview) return;
    const delay = Math.max(0, Date.parse(preview.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setExpired(true), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preview]);

  const loadDiff = (path: string) => {
    const current = preview;
    if (!current || diffs.get(path)?.state === "loading" || diffs.get(path)?.state === "loaded") return;
    const settle = (value: LoadedDiff) => {
      // A response for an earlier review must never appear under a newer one.
      if (revision.current !== current.revision) return;
      setDiffs((previous) => new Map(previous).set(path, value));
      if (value.state === "loaded") setViewed((previous) => new Set(previous).add(path));
    };
    settle({ state: "loading" });
    if (!api.setupCommitDiff) {
      settle({ state: "error", message: "Setup diffs are unavailable in this build. Review the files in Git instead." });
      return;
    }
    api.setupCommitDiff({ revision: current.revision, path }).then(
      (loaded) => settle({ state: "loaded", diff: loaded.diff, parsed: parseSetupDiff(loaded.diff, loaded.truncated) }),
      (error: unknown) => {
        if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setExpired(true);
        settle({ state: "error", message: problemDetail(error, "This diff could not be loaded. Collapse the file and open it again.") });
      },
    );
  };

  if (committed) return (
    <div className={styles.notice} data-tone={committed.recoveryRequired ? "danger" : undefined} role={committed.recoveryRequired ? "alert" : "status"}>
      <strong>{committed.recoveryRequired ? "Setup committed; Git needs attention" : "Setup committed locally"}</strong>
      {committed.recoveryRequired ? committed.run.error ?? committed.message : committed.run.status === "failed" ? "Your commit is saved. Retry opening the Hub." : "Your setup commit is saved. Continue to the completion guide."}
      {committed.run.status === "failed" || committed.recoveryRequired ? <Button type="button" size="sm" disabled={opening} onClick={onOpenHub}>{opening ? "Opening…" : committed.recoveryRequired ? "Check recovery and open Hub" : "Retry opening Hub"}</Button> : null}
    </div>
  );

  const trimmedMessage = (message ?? "").trim();
  const validMessage = trimmedMessage.length > 0 && trimmedMessage.length <= 2_000 && !trimmedMessage.includes("\0");
  const ready = Boolean(preview?.canCommit && !expired && validMessage && !review.isPending && !commit.isPending);

  return (
    <div className={styles.commitReview}>
      <div className={styles.commitReviewIntro}>
        <div>
          <h3>Review and commit setup</h3>
          <p>Review the generated changes, then save a local commit to finish setup.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={review.isPending || commit.isPending} onClick={() => review.mutate()}>
          {review.isPending ? "Loading changes…" : attempted ? "Refresh review" : "Review setup changes"}
        </Button>
      </div>
      {review.isError ? <p className={styles.notice} data-tone="danger" role="alert">{problemDetail(review.error, "The setup changes could not be loaded. Refresh the review to try again.")}</p> : null}
      {commit.isError ? <p className={styles.notice} data-tone="danger" role="alert">{problemDetail(commit.error, "The commit could not be confirmed.")} Refresh the review before trying again.</p> : null}
      {preview ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (inFlight.current || !ready) return;
          if (Date.parse(preview.expiresAt) <= Date.now()) { setExpired(true); return; }
          inFlight.current = true;
          commit.mutate({ revision: preview.revision, message: trimmedMessage });
        }}>
          <div className={styles.commitScope}>
            <strong>{preview.files.length} {preview.files.length === 1 ? "file" : "files"} in this commit</strong>
            <span>{preview.branch ? `Branch: ${preview.branch}` : preview.head ? "Detached HEAD" : "First commit"}</span>
          </div>
          <p className={styles.commitScopeNote}>Only the files listed below will be committed. Nothing is pushed.</p>
          <div className={styles.commitFiles} key={preview.revision}>
            {preview.files.map((file) => {
              const loaded = diffs.get(file.path);
              return (
                <details key={file.path} className={styles.commitFile} onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (open) next.add(file.path); else next.delete(file.path);
                    return next;
                  });
                  if (open) loadDiff(file.path);
                  else if (loaded?.state === "error") setDiffs((current) => { const next = new Map(current); next.delete(file.path); return next; });
                }}>
                  <summary>
                    <span className={styles.commitFilePath}>{file.path}</span>
                    <span className={styles.commitFileStatus} data-status={file.status}>{file.status}</span>
                    <span className={styles.commitDiffCounts} aria-label={`${file.additions} added lines, ${file.deletions} deleted lines`}>
                      <span data-change="added">+{file.additions}</span><span data-change="deleted">−{file.deletions}</span>
                    </span>
                    {viewed.has(file.path) ? <span className={styles.commitViewed}><Check aria-hidden="true" />Viewed</span> : null}
                  </summary>
                  {loaded?.state === "loaded" ? (
                    <SetupCommitDiff path={file.path} diff={loaded.diff} parsed={loaded.parsed} expanded={expanded.has(file.path)} />
                  ) : (
                    <div className={styles.commitDiff} role="region" aria-label={`Diff for ${file.path}`}>
                      {expanded.has(file.path) ? (
                        <p className={styles.commitDiffNotice} role={loaded?.state === "error" ? "alert" : "status"}>
                          {loaded?.state === "error" ? loaded.message : "Loading diff…"}
                        </p>
                      ) : null}
                    </div>
                  )}
                </details>
              );
            })}
          </div>
          <p className={styles.commitViewedCount}>Viewed {viewed.size} of {preview.files.length} files</p>
          {!preview.canCommit ? <p className={styles.notice} data-tone="warning" role="status">{preview.blockedReason ?? "These changes cannot be committed yet. Refresh the review after resolving the project state."}</p> : null}
          {expired ? <p className={styles.notice} data-tone="warning" role="status">This review expired. Refresh it before committing.</p> : null}
          <label className={styles.commitMessage}>
            <span>Commit message</span>
            <Textarea aria-label="Commit message" rows={3} maxLength={2_000} value={message ?? ""} disabled={commit.isPending} onChange={(event) => setMessage(event.target.value)} />
          </label>
          <div className={styles.footer}>
            <p>The reviewed setup files will be committed locally. You can push them later.</p>
            <Button type="submit" size="sm" disabled={!ready}>{commit.isPending ? "Committing…" : "Commit setup"}</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function problemDetail(error: unknown, fallback: string): string {
  return error instanceof HubApiError ? error.problem.detail : fallback;
}
