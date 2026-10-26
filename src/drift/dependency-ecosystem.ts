import type { Claim } from "../types.js";

const HEADING_ECOSYSTEMS = new Map<string, NonNullable<Claim["ecosystem"]>>([
  ...["npm", "pnpm", "yarn", "javascript", "typescript", "node.js", "nodejs"].map((name) => [name, "npm"] as const),
  ...["python", "pypi", "pip", "pip3", "poetry", "pyproject.toml", "requirements.txt", "setup.py"].map((name) => [name, "python"] as const),
]);
const NEUTRAL_HEADING_WORDS = new Set([
  "dependency", "dependencies", "library", "libraries", "package", "packages",
  "technology", "technologies", "stack", "tech", "core", "key", "runtime",
  "development", "dev", "production", "optional", "test", "testing",
  "tools", "tooling", "frontend", "backend", "and", "or",
]);

/** undefined means a neutral subsection; null clears inherited evidence.
 *  Recognize whole labels, not ecosystem mentions inside arbitrary prose.
 *  Unknown qualifiers can name another ecosystem (Rust, Go, etc.), so they
 *  also clear the enclosing scope without needing an exhaustive language list. */
export function headingDependencyEcosystem(heading: string): Claim["ecosystem"] | null {
  const words = heading.toLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*/gu) ?? [];
  let ecosystem: Claim["ecosystem"];
  for (const word of words) {
    const named = HEADING_ECOSYSTEMS.get(word);
    if (named) {
      if (ecosystem && ecosystem !== named) return null;
      ecosystem = named;
    } else if (!NEUTRAL_HEADING_WORDS.has(word) && !/^v?\d+(?:\.\d+)*$/.test(word)) {
      return null;
    }
  }
  return ecosystem;
}

/** A scoped npm name is unambiguous even in an otherwise unlabelled section.
 *  Hyphens, dots and underscores occur in both ecosystems and prove nothing. */
export function dependencyEcosystem(claim: Pick<Claim, "value" | "section" | "ecosystem">): Claim["ecosystem"] {
  if (/^@[^/\s]+\/[^/\s]+(?:\s|$)/.test(claim.value)) return "npm";
  return claim.ecosystem ?? (claim.section ? headingDependencyEcosystem(claim.section) : undefined) ?? undefined;
}
