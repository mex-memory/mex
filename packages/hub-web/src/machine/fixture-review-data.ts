import type { MachineReviewCard, MachineReviewQueue } from "@mex/hub-contracts/machine";
import { reviewReason } from "../../../../src/review/reasons";
import type { FixtureVariant } from "./fixtures";
import type { HomeOverview, KnowledgeDetail } from "./types";

const day = 86_400_000;
const normalActions = ["share", "keep", "edit"] as const;
type Details = Partial<Pick<MachineReviewCard, "kind" | "scope" | "sources" | "contradiction" | "retireTarget" | "disabled">>;

export function fixtureReviewQueue(now: number, notes: readonly KnowledgeDetail[], variant: FixtureVariant): MachineReviewQueue | undefined {
  if (variant === "review-loading") return;
  if (variant === "empty" || variant === "review-empty") return reviewSnapshot([]);
  const fromNow = (days: number) => new Date(now + days * day).toISOString();

  function card(
    repoId: string, cardId: string, age: number, claim: string, text: string, reason: string, details: Details = {}, expires = 30 - age,
  ): MachineReviewCard {
    const checkedByModel = Boolean(details.retireTarget);
    const actions = details.contradiction ? ["keepCurrent", "use"] as const
      : checkedByModel ? [...normalActions, "retire"] as const : normalActions;
    return {
      key: repoId + ":" + cardId, cardId, repoId, revision: "fixture-card",
      kind: "rule", claim, text, scope: ["**"], reason: reviewReason(reason), checkedByModel,
      sources: {
        count: details.contradiction || checkedByModel ? 1 : 2,
        producer: checkedByModel ? "A check by the model" : details.contradiction ? "Learn deeper" : "Learning from your sessions",
        checkouts: ["/work/" + repoId],
      },
      createdAt: fromNow(-age), expiresAt: fromNow(expires), actions: [...actions], ...details,
    };
  }

  function current(...keys: string[]) {
    return keys.map((key) => {
      const note = notes.find((note) => note.key === key);
      if (!note) throw new Error("Missing Review fixture note: " + key);
      return { key, claim: note.oneLine, audience: note.audience };
    });
  }

  const cards = [
    card("storefront", "type-check", 6, "Run the type checker before opening a pull request",
      "Run the workspace type check from the repository root before opening a pull request. A package test only checks its own imports, so it can miss a broken type in another package.\n\nIf you change a shared type, rerun the workspace check after updating its callers.",
      "preview-not-shown", {
        sources: {
          count: 3, producer: "Learning from your sessions", checkouts: ["/work/storefront", "/work/storefront-checkout"],
        },
      }),
    card("design-kit", "spacing", 5, "Use the shared spacing scale in new components",
      "Use the spacing tokens for padding and gaps. Start with the smallest token that gives each control enough room, and keep the same spacing at each density.",
      "public-session", { scope: ["packages/ui/**"] }),
    card("docs-site", "links", 4, "Check links when moving a page",
      "Run the link checker after moving a page. If a published guide points to its old address, add a redirect and check that it lands on the new page.",
      "repository-policy-changed", { kind: "procedure", scope: ["docs/**"] }),
    card("storefront", "live-cart", 3, "Read the live cart when checkout starts",
      "Build the checkout request from the live cart. Run the full cart creation flow for both guest and signed-in checkout tests so they exercise the same path as production.",
      "contradiction", {
        kind: "decision", scope: ["apps/api/**", "apps/web/**"],
        contradiction: { current: current("storefront:onlyYou:mx_snapshot", "storefront:onlyYou:mx_guestcart") },
      }),
    card("design-kit", "examples", 2, "Add a keyboard example for new controls",
      "Show how to reach, use, and leave each new control with the keyboard. Include the expected focus position after the interaction, especially when a menu or dialog closes.",
      "checks-unavailable", {
        kind: "recipe", scope: ["packages/ui/**"], disabled: { share: "Record the checks before sharing this rule." },
      }),
    card("storefront", "migrations", 1.5, "Run checkout migrations during the release",
      "Run the migrations on the release database before reopening checkout. Record row counts and any skipped records in the release checklist.",
      "contradiction", { kind: "procedure", contradiction: { current: current("storefront:onlyYou:mx_migrationcopy") } }),
    card("storefront", "fixtures", 1, "Keep real customer names out of test data",
      "Use generated names, addresses and email addresses in seed data, snapshots and support examples. Generate them with a fixed seed so the same test produces the same output on each run.\n\nWhen a failed test needs a real-world edge case, reproduce its shape with made-up values. Keep the parts that matter to the failure, such as address length or missing fields.\n\nRefresh snapshots after changing the generator. Check that the new snapshots cover both guest and signed-in checkout.\n\nUse the same generator for data shown in screenshots. This keeps the examples consistent across the help site, support replies and test runs.",
      "the code change could not be traced to this session", {
        kind: "rule", scope: ["test/fixtures/**", "apps/web/**"],
        retireTarget: current("storefront:team:mx_anonfixtures")[0],
      }),
    card("docs-site", "alt-text", 0.25, "Describe diagrams in their image captions",
      "Put the diagram’s main point in its caption so the explanation is still available when the image can’t load. Use the alt text to describe the details the caption leaves out.",
      "the model could not verify the note", {
        kind: "rule", scope: ["docs/**"], retireTarget: current("docs-site:onlyYou:mx_diagrams")[0],
      }, 1),
  ];
  return reviewSnapshot(cards, variant === "updating" || variant === "stale" ? fromNow(0) : undefined);
}

export function reviewSnapshot(cards: readonly MachineReviewCard[], updatingSince?: string): MachineReviewQueue {
  const byRepo: MachineReviewQueue["byRepo"] = {};
  let oldest: string | null = null;
  for (const card of cards) {
    byRepo[card.repoId] = (byRepo[card.repoId] ?? 0) + 1;
    if (!oldest || Date.parse(card.createdAt) < Date.parse(oldest)) oldest = card.createdAt;
  }
  return { cards, total: cards.length, byRepo, oldest, updatingSince };
}

export function fixtureHomeReview(queue: MachineReviewQueue | undefined): Pick<HomeOverview, "needs" | "needsCount"> {
  const needs = (queue?.cards ?? []).map(({ repoId, cardId, claim, createdAt }) => (
    { id: cardId, repoId, rule: claim, waitingSince: createdAt }
  )).sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  const needsCount: Record<string, HomeOverview["needsCount"][string]> = {};
  for (const { repoId, waitingSince } of needs) {
    const previous = needsCount[repoId];
    needsCount[repoId] = { count: (previous?.count ?? 0) + 1, oldest: previous?.oldest ?? waitingSince };
  }
  return { needs, needsCount };
}
