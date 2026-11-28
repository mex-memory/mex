import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { clearLearningChecks } from "../git.js";

const REVIEW = "Run the private review before release.\n";
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
});

function homeWithBatch(): { home: string; batch: string; text: string } {
  const home = mkdtempSync(join(tmpdir(), "mex-scratch-"));
  homes.push(home);
  const job = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const batch = join(home, "learn-checks", job, "batch-ABC123");
  mkdirSync(join(batch, ".mex", "projects", "p", "index"), { recursive: true });
  const text = join(batch, "CONTRIBUTING.md");
  writeFileSync(text, REVIEW);
  return { home, batch, text };
}

function remainingText(dir: string): string {
  if (!existsSync(dir)) return "";
  let text = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) text += remainingText(path);
    else if (name.isFile()) {
      try { text += readFileSync(path); } catch { /* already gone */ }
    }
  }
  return text;
}

it("removes an abandoned check batch completely", async () => {
  const { home, batch } = homeWithBatch();
  await clearLearningChecks(home, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  expect(existsSync(batch)).toBe(false);
  expect(remainingText(home)).not.toContain("private review");
});

it("drops staged review text when the check index is still open", async () => {
  const { home, text } = homeWithBatch();
  const db = new DatabaseSync(join(home, "learn-checks", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "batch-ABC123", ".mex", "projects", "p", "index", "c-held.db.tmp"));
  db.exec("CREATE TABLE held(x)");
  try {
    await expect(clearLearningChecks(home, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).resolves.toBeUndefined();
    expect(existsSync(text) ? readFileSync(text, "utf8") : "").not.toContain("private review");
    expect(remainingText(home)).not.toContain("private review");
  } finally { db.close(); }
});
