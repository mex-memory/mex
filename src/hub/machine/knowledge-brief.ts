import { MachineKnowledgeBriefRequestSchema, MachineKnowledgeBriefSchema } from "@mex/hub-contracts/machine";
import { previewBriefAsync, type BriefPreview } from "../../knowledge/brief.js";
import { KnowledgeError } from "../../knowledge/contract.js";
import type { LocationOptions } from "../../record/location.js";
import { parseKnowledgeCheckout, registeredKnowledgeCheckout } from "./knowledge-checkout.js";
import { badKnowledgeRequest } from "./knowledge-list.js";
import { HubRequestError } from "./security.js";

// The combined session-start allowance in native/brief/brief.go.
const TOKEN_LIMIT = 550;

function projectBrief(preview: BriefPreview) {
  const files = new Map((preview.coverage.files ?? []).map(({ path, agents, scope, ids }) =>
    [path, { path, agents, scope, entryCount: ids?.length ?? 0 }] as const));
  return MachineKnowledgeBriefSchema.parse({
    text: preview.text,
    tokenBound: preview.token_bound,
    tokenLimit: TOKEN_LIMIT,
    items: [...preview.corrections ?? [], ...preview.items],
    coverage: { files: [...files.values()] },
  });
}

export class KnowledgeBriefs {
  #pending = new Set<string>();
  #stop = new AbortController();

  constructor(private readonly location: LocationOptions, private readonly env?: NodeJS.ProcessEnv) {}

  async preview(input: unknown) {
    const result = MachineKnowledgeBriefRequestSchema.safeParse(input);
    if (!result.success) throw badKnowledgeRequest("Choose a registered repo, checkout, and supported agent.");
    const { agent, path, ...scope } = result.data;
    const target = registeredKnowledgeCheckout(this.location, parseKnowledgeCheckout(scope));
    if (this.#pending.has(scope.checkout)) {
      throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "A brief preview is already running for this checkout.");
    }
    this.#pending.add(scope.checkout);
    try {
      const brief = await previewBriefAsync(target, agent, path, { env: this.env, signal: this.#stop.signal });
      return projectBrief(brief);
    } catch (error) {
      if (error instanceof KnowledgeError) {
        if (error.code === "INVALID_PATH" || error.code === "INVALID_AGENT") throw badKnowledgeRequest(error.message);
        if (error.code === "CHECKS_UNAVAILABLE") throw new HubRequestError(424, "CHECKS_UNAVAILABLE", "Brief unavailable", error.message);
        if (error.code === "BRIEF_UNAVAILABLE") throw new HubRequestError(502, "BRIEF_UNAVAILABLE", "Brief unavailable", error.message);
      }
      throw new HubRequestError(502, "BRIEF_UNAVAILABLE", "Brief unavailable", "The session-start brief could not be read.");
    } finally {
      this.#pending.delete(scope.checkout);
    }
  }

  close() {
    this.#stop.abort();
  }
}
