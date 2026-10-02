import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";
import { extractFrontmatter, extractGroundings, findMexAnchors } from "../src/markdown.js";
import {
  MEX_INSTRUCTIONS_END,
  MEX_INSTRUCTIONS_START,
  renderManagedInstructionBlock,
} from "../src/agent-skills/instructions.js";

const roots: string[] = [];
const unsupportedEmbedded = [".cursorrules", ".windsurfrules", "copilot-instructions.md"];
const capabilityGuidance = [
  "mex capabilities --json",
  "smallest relevant structured resolver",
  "mex inbox contract --action <command-id> --json",
  "mex relay contract --action <command-id> --json",
  "explicitly asks to create, save, or draft a checkout-local Inbox or Relay draft",
  "preview and apply that exact draft without asking for redundant confirmation",
  "publishing, approving, rejecting, withdrawing, marking stale, repairing, taking or acknowledging, or closing",
  "requires fresh explicit confirmation after semantic preview",
  "Git commit, push, and pull as separate actions requiring their own authorization",
];

const supersededBlanketApprovalGuidance =
  "wait for explicit human approval before running an apply command";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Templates are checked out with the platform's line endings -- this repo has
 * no `text` attribute for them, so Windows gets CRLF and CI gets LF from the
 * same commit -- while the renderers always emit LF. Comparing raw bytes made
 * three of these assertions fail for every Windows contributor and pass in CI,
 * which is a property of the checkout, not of the templates under test.
 */
const readText = (path: string): string =>
  readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

describe("shipped code-graph agent guidance", () => {
  it("keeps shipped grounding examples inert while the populated dogfood grounding stays real", () => {
    for (const name of ["architecture", "conventions", "decisions", "setup", "stack"]) {
      const content = readText(join("templates", "context", `${name}.md`));
      expect(extractFrontmatter(content)?.grounds_to, `templates/${name}`).toEqual([]);
      expect(content, `templates/${name}`).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
      expect(findMexAnchors(content), `templates/${name} examples must stay inert`).toEqual([]);
    }

    const dogfoodPattern = readText(".mex/patterns/dogfood-mex-setup.md");
    const dogfoodGroundings = extractGroundings(dogfoodPattern);
    expect(dogfoodGroundings.length).toBeGreaterThan(0);
    expect(findMexAnchors(dogfoodPattern).map((anchor) => anchor.nodeId))
      .toEqual(expect.arrayContaining(dogfoodGroundings.map((grounding) => grounding.node)));
    for (const name of ["architecture", "conventions", "decisions", "setup", "stack"]) {
      const content = readText(join(".mex/context", `${name}.md`));
      expect(content, `.mex/${name}`).not.toContain("mex://function:<tier-1-id>");
      expect(content, `.mex/${name}`).not.toContain("[YYYY-MM-DD]");
    }

    for (const area of ["templates", ".mex"]) {
      const patterns = readText(join(area, "patterns/README.md"));
      expect(patterns).toContain("grounds_to:");
      expect(patterns).toContain('fingerprint: "mh2:64:<base64url-fingerprint>"');
      expect(patterns).toContain("[`someFunction()`](mex://function:<tier-1-id>)");
      expect(findMexAnchors(patterns), `${area}/patterns examples must stay inert`).toEqual([]);
    }
  });

  it("keeps common guidance aligned without promising skills to unsupported clients", () => {
    const unsupported = unsupportedEmbedded.map((name) => (
      readText(join("templates/.tool-configs", name))
    ));
    expect(new Set(unsupported).size).toBe(1);
    for (const content of unsupported) {
      expect(content).toContain("mex impact <symbol|file>");
      expect(content).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
      expect(content).toContain("adjudicate any AMBIGUOUS grounding");
      expect(content).toContain("refreshed grounding is re-emitted");
      for (const guidance of capabilityGuidance) expect(content).toContain(guidance);
      expect(content).not.toContain(MEX_INSTRUCTIONS_START);
      expect(content).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
      expect(content).not.toContain(supersededBlanketApprovalGuidance);
    }

    const claude = readText("templates/.tool-configs/CLAUDE.md");
    expect(claude).toContain(renderManagedInstructionBlock("claude"));
    expect(claude).toContain("/mex-inbox");
    expect(claude).not.toContain("$mex-inbox");
    expect(claude).not.toContain(supersededBlanketApprovalGuidance);
  });

  it("keeps maintained equivalents aligned and OpenCode delegated to guided AGENTS.md", () => {
    const maintainedUnsupported = unsupportedEmbedded.map((name) => (
      readText(join(".mex/.tool-configs", name))
    ));
    expect(new Set(maintainedUnsupported).size).toBe(1);
    expect(maintainedUnsupported[0]).toContain("mex impact <symbol|file>");
    expect(readText(".mex/.tool-configs/CLAUDE.md"))
      .toContain(renderManagedInstructionBlock("claude"));
    const agents = readText("templates/AGENTS.md");
    expect(agents).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    expect(agents).toContain(MEX_INSTRUCTIONS_START);
    expect(agents).toContain("mention MEX and the relevant finding naturally in your explanation");
    expect(agents).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    for (const guidance of capabilityGuidance) expect(agents).toContain(guidance);
    expect(agents).not.toContain(supersededBlanketApprovalGuidance);
    const agentMemory = readText("templates/agent-memory/AGENTS.md");
    for (const guidance of capabilityGuidance) expect(agentMemory).toContain(guidance);
    expect(agentMemory).not.toContain(supersededBlanketApprovalGuidance);
    expect(agentMemory).toContain(MEX_INSTRUCTIONS_START);
    expect(agentMemory).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    const maintainedAgents = readText(".mex/AGENTS.md");
    for (const guidance of capabilityGuidance) expect(maintainedAgents).toContain(guidance);
    expect(maintainedAgents).not.toContain(supersededBlanketApprovalGuidance);
    expect(maintainedAgents).toContain(MEX_INSTRUCTIONS_START);
    expect(maintainedAgents).not.toMatch(/[/$]mex-(?:inbox|relay)/u);
    for (const guidance of capabilityGuidance) expect(maintainedUnsupported[0]).toContain(guidance);
    for (const file of ["templates/.tool-configs/opencode.json", ".mex/.tool-configs/opencode.json"]) {
      expect(JSON.parse(readText(file)).instructions).toContain(".mex/AGENTS.md");
    }
  });

  it("keeps root dogfood instructions minimal and client-specific", () => {
    expect(readText("CLAUDE.md"))
      .toBe(`${renderManagedInstructionBlock("claude")}\n`);
    expect(readText("AGENTS.md"))
      .toBe(`${renderManagedInstructionBlock("codex")}\n`);
  });

  it("passes tool-config-sync after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-tool-configs-"));
    roots.push(root);
    writeFileSync(join(root, "CLAUDE.md"), `${renderManagedInstructionBlock("claude")}\n`);
    writeFileSync(join(root, "AGENTS.md"), `${renderManagedInstructionBlock("codex")}\n`);
    const content = readText("templates/.tool-configs/.cursorrules");
    for (const path of [".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    expect(checkToolConfigSync(root)).toEqual([]);
    expect(readText(join(root, "CLAUDE.md"))).toContain(MEX_INSTRUCTIONS_END);
  });
});
