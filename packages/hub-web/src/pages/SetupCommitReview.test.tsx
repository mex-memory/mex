import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HubApiError } from "../api/client";
import type { SetupCommitDiff, SetupCommitFile, SetupCommitPreview, SetupCommitResponse } from "../api/types";
import { SetupCommitReview } from "./SetupCommitReview";

const revision = "a944e8d9-7e02-4d04-9a62-d8b347b8e7dc";
const renewedRevision = "75eff665-7fbe-4b1b-9bf8-9ab33e6f3739";
type ReviewedFile = SetupCommitFile & { diff: string };
const file = (path: string, status: SetupCommitFile["status"], diff: string, update: Partial<SetupCommitFile> = {}): ReviewedFile => ({
  path, status, diff, additions: 0, deletions: 0, diffCharacters: diff.length, truncated: false, ...update,
});
const defaultFiles = [
  file(".mex/config.json", "added", "diff --git a/.mex/config.json b/.mex/config.json\n+{\"scaffold_id\":\"example\"}", { additions: 1 }),
  file(".mex/AGENTS.md", "modified", "-old instructions\n+<img src=x onerror=alert(1)>", { additions: 1, deletions: 1 }),
];
/** The preview carries metadata only; tests keep each file's text for the on-demand diff route. */
const makePreview = (update: Partial<Omit<SetupCommitPreview, "files">> & { files?: ReviewedFile[] } = {}): SetupCommitPreview & { reviewed: ReviewedFile[] } => {
  const reviewed = update.files ?? defaultFiles;
  return {
    revision, expiresAt: new Date(Date.now() + 600_000).toISOString(), branch: "feature/setup", head: null,
    defaultMessage: "chore: initialize MEX", canCommit: true, blockedReason: null, ...update,
    files: reviewed.map(({ diff: _diff, ...summary }) => summary), reviewed,
  };
};
const result: SetupCommitResponse = {
  commit: "a".repeat(40), files: [".mex/config.json", ".mex/AGENTS.md"], message: "Setup committed locally.",
  run: {
    status: "running", mode: "code-repo", stage: "ready", ready: false, populated: true,
    selectedTools: ["codex"], prompt: null, populationTool: "codex", populationCompleted: true,
    commitCommands: [], anchorNotes: [], message: "Opening the Hub…", progress: null,
    error: null, startedAt: new Date().toISOString(), finishedAt: null,
  },
};

function harness(preview = makePreview()) {
  let current = preview;
  const api = {
    previewSetupCommit: vi.fn(async () => {
      const { reviewed: _reviewed, ...next } = current;
      return next;
    }),
    setupCommitDiff: vi.fn(async ({ revision: requested, path }: { revision: string; path: string }): Promise<SetupCommitDiff> => {
      const match = current.reviewed.find((entry) => entry.path === path)!;
      return { revision: requested, path, diff: match.diff, truncated: match.truncated };
    }),
    commitSetup: vi.fn(async () => result),
    serve: (next: ReturnType<typeof makePreview>) => { current = next; },
  };
  const onCommitted = vi.fn();
  const onReviewInvalid = vi.fn();
  const onOpenHub = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SetupCommitReview api={api} onCommitted={onCommitted} onReviewInvalid={onReviewInvalid} onOpenHub={onOpenHub} /></QueryClientProvider>);
  return { api, onCommitted, onReviewInvalid, onOpenHub, ...view };
}

async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review setup changes" }));
  return await screen.findByRole("button", { name: "Commit setup" });
}

describe("setup commit review", () => {
  it("loads only on request, displays exact escaped diffs, and submits the displayed revision and edited message once", async () => {
    const user = userEvent.setup();
    const h = harness();
    expect(h.api.previewSetupCommit).not.toHaveBeenCalled();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
    const submit = await review(user);
    expect(screen.getByText("2 files in this commit")).toBeVisible();
    expect(screen.getByText("Branch: feature/setup")).toBeVisible();
    expect(screen.getByText(/Only the files listed below will be committed/)).toBeVisible();
    expect(h.api.setupCommitDiff).not.toHaveBeenCalled();
    const files = h.container.querySelectorAll("details");
    fireEvent.click(files[1]!.querySelector("summary")!);
    await waitFor(() => expect(screen.getByText("Viewed 1 of 2 files")).toBeVisible());
    expect(h.api.setupCommitDiff).toHaveBeenCalledExactlyOnceWith({ revision, path: ".mex/AGENTS.md" });
    expect(screen.getByLabelText("Diff for .mex/AGENTS.md")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(h.container.querySelector("img")).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "Commit message" }));
    await user.type(screen.getByRole("textbox", { name: "Commit message" }), "  chore: add project memory  ");
    let resolveCommit!: (value: SetupCommitResponse) => void;
    h.api.commitSetup.mockImplementationOnce(() => new Promise((resolve) => { resolveCommit = resolve; }));
    await user.dblClick(submit);
    expect(h.api.commitSetup).toHaveBeenCalledExactlyOnceWith({ revision, message: "chore: add project memory" });
    expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeDisabled();
    await act(async () => { resolveCommit(result); });
    await waitFor(() => expect(h.onCommitted).toHaveBeenCalledExactlyOnceWith(result));
    expect(screen.queryByRole("button", { name: "Commit setup" })).toBeNull();
  });

  it("invalidates a stale review and requires a fresh revision before another commit", async () => {
    const user = userEvent.setup();
    const h = harness();
    h.api.commitSetup.mockRejectedValueOnce(new HubApiError({
      type: "about:blank", title: "Review changed", status: 409, code: "REVISION_CONFLICT", detail: "The setup files changed after review.", requestId: "commit-test",
    }));
    await user.click(await review(user));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh the review before trying again");
    expect(h.onReviewInvalid).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Commit setup" })).toBeNull();
    h.api.serve(makePreview({ revision: renewedRevision }));
    await user.click(screen.getByRole("button", { name: "Refresh review" }));
    await user.click(await screen.findByRole("button", { name: "Commit setup" }));
    expect(h.api.commitSetup).toHaveBeenLastCalledWith({ revision: renewedRevision, message: "chore: initialize MEX" });
  });

  it("shows a blocked or truncated review without allowing a commit", async () => {
    const user = userEvent.setup();
    const h = harness(makePreview({ canCommit: false, blockedReason: "A Git hook requires a manual commit.", files: [file(".mex/AGENTS.md", "modified", "large diff", { truncated: true })] }));
    expect(await review(user)).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("A Git hook requires a manual commit.");
    fireEvent.click(h.container.querySelector("summary")!);
    expect(await screen.findByText(/This diff was shortened/)).toBeVisible();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
  });

  it("shows per-file change counts and preserves viewed state while releasing closed diff rows", async () => {
    const user = userEvent.setup();
    const h = harness(makePreview({ files: [file("AGENTS.md", "modified", "diff --git a/AGENTS.md b/AGENTS.md\nindex abcd123..def4567 100644\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n", { additions: 2, deletions: 1 })] }));
    await review(user);
    expect(screen.getByLabelText("2 added lines, 1 deleted lines")).toBeVisible();
    expect(h.container.querySelector("table")).toBeNull();
    await user.click(h.container.querySelector("summary")!);
    await waitFor(() => expect(h.container.querySelector("table")).not.toBeNull());
    expect(screen.getByText("Viewed 1 of 1 files")).toBeVisible();
    await user.click(h.container.querySelector("summary")!);
    await waitFor(() => expect(h.container.querySelector("table")).toBeNull());
    expect(screen.getByText("Viewed 1 of 1 files")).toBeVisible();
    // Reopening reuses the retained diff for this revision.
    await user.click(h.container.querySelector("summary")!);
    await waitFor(() => expect(h.container.querySelector("table")).not.toBeNull());
    expect(h.api.setupCommitDiff).toHaveBeenCalledOnce();
  });

  it("marks a file viewed only after its diff loads and retries a failed load on reopen", async () => {
    const user = userEvent.setup();
    const h = harness();
    await review(user);
    let finish!: (value: SetupCommitDiff) => void;
    h.api.setupCommitDiff
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new HubApiError({ type: "about:blank", title: "Not found", status: 404, code: "NOT_FOUND", detail: "This file is not part of the current setup review.", requestId: "diff-test" }));
    const [config, agents] = h.container.querySelectorAll("summary");
    await user.click(config!);
    expect(screen.getByRole("status")).toHaveTextContent("Loading diff…");
    expect(screen.getByText("Viewed 0 of 2 files")).toBeVisible();
    await act(async () => { finish({ revision, path: ".mex/config.json", diff: "+{}\n", truncated: false }); });
    await waitFor(() => expect(screen.getByText("Viewed 1 of 2 files")).toBeVisible());
    await user.click(agents!);
    expect(await screen.findByRole("alert")).toHaveTextContent("not part of the current setup review");
    expect(screen.getByText("Viewed 1 of 2 files")).toBeVisible();
    await user.click(agents!);
    await user.click(agents!);
    await waitFor(() => expect(screen.getByText("Viewed 2 of 2 files")).toBeVisible());
    expect(h.api.setupCommitDiff).toHaveBeenCalledTimes(3);
  });

  it("drops a diff that arrives for an earlier review and treats a stale diff as an expired review", async () => {
    const user = userEvent.setup();
    const h = harness();
    await review(user);
    let late!: (value: SetupCommitDiff) => void;
    h.api.setupCommitDiff.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    await user.click(h.container.querySelector("summary")!);
    h.api.serve(makePreview({ revision: renewedRevision }));
    await user.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByRole("button", { name: "Commit setup" });
    await act(async () => { late({ revision, path: ".mex/config.json", diff: "+stale text\n", truncated: false }); });
    expect(screen.queryByText("stale text")).toBeNull();
    expect(screen.getByText("Viewed 0 of 2 files")).toBeVisible();

    h.api.setupCommitDiff.mockRejectedValueOnce(new HubApiError({ type: "about:blank", title: "Review changed", status: 409, code: "REVISION_CONFLICT", detail: "The setup files changed after review.", requestId: "diff-stale" }));
    await user.click(h.container.querySelector("summary")!);
    expect(await screen.findByText("This review expired. Refresh it before committing.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Commit setup" })).toBeDisabled();
  });

  it("rechecks expiry at the explicit commit action and disables empty messages", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const h = harness(makePreview({ expiresAt: new Date(now + 60_000).toISOString() }));
    const submit = await review(user);
    await user.clear(screen.getByRole("textbox", { name: "Commit message" }));
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Commit message" }), "Review setup");
    clock.mockReturnValue(now + 60_001);
    await user.click(submit);
    expect(screen.getByRole("status")).toHaveTextContent("This review expired");
    expect(submit).toBeDisabled();
    expect(h.api.commitSetup).not.toHaveBeenCalled();
  });

  it("keeps a successful commit separate from a failed Hub opening and offers only an open retry", async () => {
    const user = userEvent.setup();
    const h = harness();
    h.api.commitSetup.mockResolvedValueOnce({ ...result, run: { ...result.run, status: "failed", error: "The Hub could not open." } });
    await user.click(await review(user));
    expect(await screen.findByText("Setup committed locally")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Commit setup" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry opening Hub" }));
    expect(h.onOpenHub).toHaveBeenCalledOnce();
    expect(h.api.commitSetup).toHaveBeenCalledOnce();
  });
});
