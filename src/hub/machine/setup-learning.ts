import { MachineSetupQuoteRequestSchema, type MachineSetupLearning, type MachineSetupQuote } from "@mex/hub-contracts/machine";
import { randomBytes } from "node:crypto";
import { SourceError } from "../../learn-deeper/forge.js";
import { LEARN_KIND, type LearningPlan } from "../../learn-deeper/plan.js";
import { prepareLearningQuote } from "../../learn-deeper/quote.js";
import { openHooksReadOnly, openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { realPath } from "../../record/project.js";
import { machineBusy } from "./agent-repair.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";
import { readSetupTarget, setupOfferRevision } from "./setup-snapshot.js";

const QUOTE_TTL_MS = 5 * 60_000;
const QUOTE_LIMIT = 128;
const MAX_ACTIVE = 2;

type Approval = {
  repoId: string;
  session: string;
  expires: number;
  offerRevision: string;
  quote: MachineSetupQuote & { revision: string };
  plan: LearningPlan;
};

function staleQuote() {
  return new HubRequestError(409, "REVISION_CONFLICT", "The learning estimate changed", "Open the current estimate and try again.");
}

function isSameCheckout(path: string) {
  try { return realPath(path) === path; } catch { return false; }
}

export class SetupLearning {
  #approvals = new Map<string, Approval>();
  #active = new Set<string>();

  constructor(private readonly location: LocationOptions, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv) {}

  async quote(repoId: string, session: string, body: unknown): Promise<MachineSetupLearning> {
    const parsed = MachineSetupQuoteRequestSchema.safeParse(body);
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid learning request", "Open the current learning offer.");
    const offerRevision = parsed.data.expectedRevision;
    return this.#run(repoId, async () => {
      try {
        return await this.#read(repoId, offerRevision, async (reader, root) => {
          for (const [revision, approval] of this.#approvals) {
            if (approval.expires <= this.now()) this.#approvals.delete(revision);
            else if (approval.session === session && approval.repoId === repoId && approval.offerRevision === offerRevision) {
              return { state: "offered", quote: approval.quote };
            }
          }
          const current = await prepareLearningQuote(reader, { root, projectId: repoId, location: this.location, env: this.env, now: this.now });
          if (current.state === "no-review-remote") return current;
          if (current.state === "unavailable") return { state: current.state, reason: current.reason };
          const { plan, minutes } = current;
          const quote = {
            revision: randomBytes(32).toString("hex"), agent: plan.agent === "claude" ? "Claude Code" : "Codex",
            tokens: plan.estimate, ceilingTokens: plan.ceiling, seconds: minutes * 60, privateRepo: plan.visibility === "private", weekly: plan.refresh,
          } as const;
          this.#approvals.set(quote.revision, { repoId, session, expires: this.now() + QUOTE_TTL_MS, offerRevision, quote, plan });
          if (this.#approvals.size > QUOTE_LIMIT) this.#approvals.delete(this.#approvals.keys().next().value!);
          return { state: "offered", quote };
        });
      } catch (error) {
        if (error instanceof HubRequestError || machineBusy(error)) throw error;
        const reason = error instanceof SourceError ? error.message : "The learning estimate couldn’t be prepared.";
        return { state: "unavailable", reason };
      }
    });
  }

  async #run<T>(repoId: string, action: () => Promise<T>): Promise<T> {
    if (this.#active.has(repoId) || this.#active.size >= MAX_ACTIVE) {
      throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
    }
    this.#active.add(repoId);
    try { return await action(); }
    finally { this.#active.delete(repoId); }
  }

  async #read<T>(repoId: string, revision: string, use: (reader: RecordReader, root: string) => Promise<T>): Promise<T> {
    const reader = openRecordReadOnly(this.location);
    try {
      if (reader?.diagnostic) throw new Error(reader.diagnostic);
      if (!reader) throw staleQuote();
      return await use(reader, this.#requireOffer(reader, repoId, revision));
    } finally { reader?.close(); }
  }

  #requireOffer(reader: Pick<RecordReader, "all" | "get" | "setting">, repoId: string, revision: string) {
    const location = recordLocation({ ...this.location, create: false });
    const target = readStore(openHooksReadOnly, this.location, hooks => readSetupTarget(reader, hooks, location, repoId, this.now()));
    if (!target?.enabled || target.missing || target.run?.caller !== "person" || this.env.MEX_OFF === "1"
      || !isSameCheckout(target.checkout.path) || setupOfferRevision(target) !== revision
      || reader.get("SELECT 1 FROM jobs WHERE project_id=? AND kind=? LIMIT 1", repoId, LEARN_KIND)) throw staleQuote();
    return target.checkout.path;
  }
}
