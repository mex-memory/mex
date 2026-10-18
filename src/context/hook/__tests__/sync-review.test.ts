import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { runDriftCheck } from "../../../drift/index.js";
import { runSync } from "../../../sync/index.js";
import type { MexConfig } from "../../../types.js";
import { mutateFlags } from "../../flags.js";
import { recordConfirmation } from "../../session.js";
import { settleOnce, type CliRunner } from "../settle.js";
import { BILLING_V1, createHookProject, promptPayload } from "./fixture.js";

vi.mock("../../../cli-tools.js", () => ({ isCliAvailable: () => true }));

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    cleanupProjects();
  } catch {
    // A temporary directory left behind costs nothing.
  }
  vi.unstubAllEnvs();
});

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", ms: 1 });
const fakeCli: CliRunner = (args) => {
  if (args[0] !== "wiki") return ok();
  const ids = args.filter((a) => a.startsWith("mx_"));
  return ok(JSON.stringify({ ok: true, data: { entities: ids.map((id) => ({ entityId: id, ok: true })) }, diagnostics: [] }));
};

describe("sync handles session-touched entities", () => {
  it("check shows GROUNDING_REVIEW, sync's session rewrites or confirms, check is clean; an untouched entry stays", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const project = await createHookProject();
    await project.run(promptPayload("s-sync", "Fix the order total"));
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return items.length;", "return items.length + 1;")
      .replace("return total - 1;", "return total - 2;").replace("return `Total: ${total}`;", "return `Total = ${total}`;"));
    // total is confirmed inside the session and re-recorded by the settle worker; discount and invoice stay flagged.
    recordConfirmation(project.fx.context.localDir, "s-sync", [project.ids.total]);
    await settleOnce(project.fx.context, { sessionId: "s-sync", runCli: fakeCli });

    const config: MexConfig = { projectRoot: project.fx.root, scaffoldRoot: project.fx.context.scaffoldRoot, aiTools: ["claude"] };
    const reviewIds = async () => (await runDriftCheck(config, { graphWarning: () => {} })).issues
      .filter((issue) => issue.code === "GROUNDING_REVIEW").map((issue) => issue.entity?.id).sort();
    expect(await reviewIds()).toEqual([project.ids.total, project.ids.discount, project.ids.invoice].sort());

    let brief = "";
    const markdown = join(project.fx.context.scaffoldRoot, "context", "billing.md");
    const runAgent = vi.fn((_tool: unknown, prompt: string) => {
      brief = prompt;
      // The session rewrites the discount prose and confirms the invoice fact (what `mex context confirm` writes);
      // it leaves the total fact alone.
      writeFileSync(markdown, readFileSync(markdown, "utf8").replace("subtracts exactly one currency unit", "subtracts exactly two currency units"));
      mutateFlags(project.fx.context.localDir, (flags) => {
        const entry = flags.entities[project.ids.invoice]!;
        entry.status = "eligible";
        entry.basis = "confirmed";
        entry.updatedAt = new Date().toISOString();
      });
      return true;
    });
    const answers = ["1", "n"];
    await runSync(config, { includeWarnings: true }, { ask: async () => answers.shift() ?? "n", runAgent, reviewGrounding: false, rebuildWikiIndex: async () => ({ entityCount: 0 }) });

    expect(runAgent).toHaveBeenCalledTimes(1);
    // The brief names each fact, what the session changed, and the fact's current links.
    expect(brief).toContain("GROUNDING_REVIEW");
    expect(brief).toContain(project.ids.discount);
    expect(brief).toMatch(/edited #applyDiscount in src\/billing\.ts/);
    expect(brief).toMatch(/current links: #applyDiscount src\/billing\.ts:\d+-\d+/);
    // Rewritten and confirmed entries are cleared; the unchanged, unconfirmed one stays.
    expect(await reviewIds()).toEqual([project.ids.total]);
    // Someone confirms the last one: check is clean.
    const { runContextConfirm } = await import("../../cli.js");
    await runContextConfirm({ write: () => undefined, writeError: () => undefined, setExitCode: () => undefined, cwd: project.fx.root }, [project.ids.total], { json: true });
    expect(await reviewIds()).toEqual([]);
  }, 120_000);
});
