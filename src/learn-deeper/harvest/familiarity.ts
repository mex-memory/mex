import { globToRegExp } from "../../file-index/glob.js";
import type { PinnedTree } from "../git.js";
import { sourceDigest } from "../source.js";
import { reviewerKey, safeRaw } from "./evidence.js";
import type { Candidate, HarvestCursor, HarvestDeps } from "./types.js";

const TEAM = /^@[\w-]+\/[\w-]+$/u;
const HANDLE = /^@[\w-]+$/u;
const MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "pom.xml", "composer.json", "Gemfile"];
const MAX_HISTORY_KEYS = 4096;
type OwnerRule = { match: RegExp; owners: string[] };

function ownerRules(raw: string): OwnerRule[] {
  return raw.split(/\r?\n/u).flatMap(line => {
    const [pattern, ...values] = line.split("#", 1)[0]!.trim().split(/\s+/u);
    // CODEOWNERS does not implement negation, character classes or escaped whitespace.
    if (!pattern || /[!\[\]{}\\]/u.test(pattern) || safeRaw(pattern) !== pattern) return [];
    const bare = pattern.replace(/^\//u, "").replace(/\/$/u, "");
    const prefix = pattern.startsWith("/") || bare.includes("/") ? "" : "**/";
    const suffix = pattern.endsWith("/") || !/[*?]/u.test(bare) ? "/**" : "";
    const owners = values.map(owner => owner.toLowerCase()).filter(owner => HANDLE.test(owner) || TEAM.test(owner));
    return [{ match: globToRegExp(prefix + bare + suffix), owners }];
  });
}

export class Familiarity {
  private readonly packages = new Map<string, string | undefined>();
  private historyKeys: number;
  private constructor(private readonly slug: string, private readonly tree: PinnedTree,
    private readonly rules: OwnerRule[], private readonly history: NonNullable<HarvestCursor["familiarity"]>,
    private readonly teams: HarvestDeps["teams"]) {
    this.historyKeys = Object.keys(history).length;
  }

  static async open(slug: string, tree: PinnedTree, history: NonNullable<HarvestCursor["familiarity"]>, teams: HarvestDeps["teams"]):
  Promise<Familiarity> {
    const path = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find(candidate => tree.has(candidate));
    const raw = path ? await tree.read(path) : undefined;
    return new Familiarity(slug, tree, raw && safeRaw(raw) !== undefined ? ownerRules(raw).reverse() : [], history, teams);
  }

  private unit(path: string): string | undefined {
    if (this.packages.has(path)) return this.packages.get(path);
    const dirs = path.split("/");
    dirs.pop();
    let unit: string | undefined;
    for (let depth = dirs.length; depth >= 0; depth--) {
      const dir = dirs.slice(0, depth).join("/");
      if (MANIFESTS.some(name => this.tree.has(dir ? `${dir}/${name}` : name))) { unit = dir; break; }
    }
    this.packages.set(path, unit);
    return unit;
  }

  private keys(reviewer: string, path: string): string[] {
    const keys = [sourceDigest(`${reviewer}\npath:${path}`)];
    const unit = this.unit(path);
    if (unit !== undefined) keys.push(sourceDigest(`${reviewer}\npackage:${unit}`));
    return keys;
  }

  observe(login: string, path: string, pull: number, at: string): void {
    for (const key of this.keys(reviewerKey(this.slug, login), path)) {
      const prior = this.history[key];
      if (!prior && this.historyKeys >= MAX_HISTORY_KEYS) continue;
      const visits = prior ?? [];
      if (!visits.some(visit => visit.pull === pull)) {
        if (!prior) this.historyKeys++;
        this.history[key] = [...visits, { pull, at }].sort((a, b) => a.at.localeCompare(b.at) || a.pull - b.pull).slice(0, 2);
      }
    }
  }

  knows(login: string, path: string, pull: number, at: string): boolean {
    const handle = "@" + login.toLowerCase();
    const teams = (this.teams?.get(login.toLowerCase()) ?? []).map(team => team.toLowerCase().replace(/^@?/u, "@"));
    const matching = this.rules.find(rule => rule.match.test(path));
    return !!matching?.owners.some(owner => owner === handle || teams.includes(owner))
      || this.reviewedBefore(reviewerKey(this.slug, login), path, pull, at);
  }

  private reviewedBefore(reviewer: string, path: string, pull: number, at: string): boolean {
    return this.keys(reviewer, path).some(key => (this.history[key] ?? []).filter(visit => visit.pull !== pull && visit.at < at).length >= 2);
  }

  /** Newest-first sampling can discover earlier reviewers after an initial batch was emitted. */
  static corroborate(candidates: readonly Candidate[], cursor: HarvestCursor, tree: PinnedTree): Candidate[] {
    const index = new Familiarity("", tree, [], cursor.familiarity ?? {}, undefined);
    return candidates.map(candidate => {
      const { kind, path, pull, at, reviewers, weights } = candidate;
      if (kind !== "review-thread" || !path || pull === undefined || weights.familiar
        || !reviewers.some(reviewer => index.reviewedBefore(reviewer, path, pull, at))) return candidate;
      return { ...candidate, weights: { ...weights, familiar: true }, signal: weights.actedOn ? "strong" : candidate.signal };
    });
  }
}

export const corroborateReviewFamiliarity = Familiarity.corroborate;
