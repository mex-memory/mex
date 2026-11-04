import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const SKILLS = ["mex-inbox", "mex-relay"] as const;

function readSkill(name: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const path = join("skills", name, "SKILL.md");
  const content = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
  if (!match) throw new Error(`${path} has no YAML frontmatter.`);
  return {
    frontmatter: parseYaml(match[1]!) as Record<string, unknown>,
    body: match[2]!,
  };
}

describe("packaged official agent skills", () => {
  it("keeps this repository configured to dogfood both supported clients", () => {
    const config = JSON.parse(readFileSync(".mex/config.json", "utf8")) as {
      aiTools?: string[];
    };
    expect(config.aiTools).toEqual(["claude", "codex"]);
  });

  // Several clients drop a skill without any warning when these rules are broken.
  it.each([...SKILLS, "mex-statechart"])("keeps %s loadable by every skill client", (name) => {
    const { frontmatter } = readSkill(name);
    expect(frontmatter.name).toBe(name);
    expect(String(frontmatter.name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
  });

  it.each(SKILLS)("keeps %s portable, named correctly, and progressively loaded", (name) => {
    const skillPath = join("skills", name, "SKILL.md");
    const { frontmatter, body } = readSkill(name);
    expect(basename(dirname(skillPath))).toBe(name);
    expect(frontmatter.name).toBe(name);
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(frontmatter).not.toHaveProperty("allowed-tools");
    expect(frontmatter).not.toHaveProperty("permissions");
    expect(String(frontmatter.description)).toContain(`/${name}`);
    expect(String(frontmatter.description)).toContain(`$${name}`);
    expect(body.split(/\r?\n/u).length).toBeLessThan(80);
    expect(body).toContain("references/cli-workflows.md");
    expect(body).not.toMatch(/TODO|example file|replace me/iu);

    const reference = readFileSync(join("skills", name, "references", "cli-workflows.md"), "utf8");
    expect(reference).toContain(`mex ${name === "mex-inbox" ? "inbox" : "relay"} contract --action <command-id> --json`);
    expect(reference).not.toContain("mex capabilities --json\n```\n");

    const metadata = parseYaml(
      readFileSync(join("skills", name, "agents", "openai.yaml"), "utf8"),
    ) as { interface?: { default_prompt?: string } };
    expect(metadata.interface?.default_prompt).toContain(`$${name}`);
  });

  it("routes explicit knowledge contributions while keeping routine upkeep outside Inbox", () => {
    const { frontmatter, body } = readSkill("mex-inbox");
    const description = String(frontmatter.description);
    for (const positive of ["project knowledge", "addition or correction", "team review"]) {
      expect(description.toLowerCase()).toContain(positive);
    }
    for (const negative of ["email inboxes", "brainstorming alone", "routine grow upkeep", "session logs"]) {
      expect(description.toLowerCase()).toContain(negative);
    }
    expect(body).toContain("one `knowledge.create` or `knowledge.update`");
    expect(body).toContain("/inbox?view=drafts&draft=<id>");
  });

  it("bounds Relay activation to durable handoffs and truthful sharing", () => {
    const { frontmatter, body } = readSkill("mex-relay");
    const description = String(frontmatter.description).toLowerCase();
    for (const positive of ["handoff", "end-of-session", "next engineer", "take or close"]) {
      expect(description).toContain(positive);
    }
    for (const negative of ["chat", "notifications", "task assignment", "jira replacement"]) {
      expect(description).toContain(negative);
    }
    expect(body).toContain("Default to a standalone Relay");
    expect(body).toContain("/relays?view=drafts&draft=<id>");
    expect(body).toContain("commit/push and their own pull or refresh");
  });
});
