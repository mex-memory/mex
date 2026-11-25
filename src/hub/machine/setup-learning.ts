import { MachineSetupLearningDecisionSchema, MachineSetupQuoteRequestSchema, type MachineSetupLearning, type MachineSetupQuote } from "@mex/hub-contracts/machine";
import { randomBytes } from "node:crypto";
import { SourceError } from "../../learn-deeper/forge.js";
import { origin, revision } from "../../learn-deeper/git.js";
import { LEARN_KIND, type LearningPlan } from "../../learn-deeper/plan.js";
import { prepareLearningQuote } from "../../learn-deeper/quote.js";
import { LEARNING_DISMISSED, queueLearning } from "../../learn-deeper/queue.js";
import { ensureBackground } from "../../record/background.js";
import { openHooksReadOnly, openRecordReadOnly, type RecordReader, type RecordWriter } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { realPath } from "../../record/project.js";
import { waitForRecordWriter } from "../../record/writer-wait.js";
import { stepFromRow } from "../../repo-start/steps.js";
import { machineBusy } from "./agent-repair.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";
import { hubSetupStep, readSetupTarget, setupOfferRevision, setupRevision } from "./setup-snapshot.js";

const QUOTE_TTL_MS = 5 * 60_000;
const QUOTE_LIMIT = 128;
const MAX_ACTIVE = 2;

type OfferReader = Pick<RecordReader, "all" | "get" | "setting">;
function readWriter(writer: RecordWriter): OfferReader {
  return {
    all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never,
    get: (sql, ...args) => writer.db.prepare(sql).get(...args) as never,
    setting: (scope, key) => writer.setting(scope, key),
  };
}

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

function planRevision({ since: _since, until: _until, ...plan }: LearningPlan) {
  // Clock movement alone changes the source window bounds. Its selected
  // sources, pinned revision, agent and budget must all still match.
  return setupRevision(plan);
}

export class SetupLearning {
  #approvals = new Map<string, Approval>();
  #active = new Set<string>();

  constructor(
    private readonly location: LocationOptions, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv,
    private readonly entry?: string,
  ) {}

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

  async start(repoId: string, session: string, body: unknown) {
    return this.#run(repoId, async () => {
      const approval = this.#approval(repoId, session, body);
      const { quote, plan, offerRevision } = approval;
      try {
        await this.#read(repoId, offerRevision, async (reader, root) => {
          const current = await prepareLearningQuote(reader, { root, projectId: repoId, location: this.location, env: this.env, now: this.now });
          if (current.state !== "offered" || planRevision(current.plan) !== planRevision(plan)) throw staleQuote();
          // The repository can change while the inventory request is in flight.
          const [head, remote] = await Promise.all([revision(root), origin(root)]);
          if (head !== plan.head || remote?.host !== plan.origin.host || remote.slug !== plan.origin.slug) throw staleQuote();
        });
        const writer = await waitForRecordWriter(this.location);
        let step;
        try {
          const reader = readWriter(writer);
          const { job, existing } = queueLearning(writer, repoId, { ...plan, waitForSetup: true }, jobId => {
            const root = this.#requireOffer(reader, repoId, offerRevision);
            if (root !== plan.checkout || approval.expires <= this.now()) throw staleQuote();
            writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(
              repoId, "hub.setup.consent." + setupRevision([repoId, LEARN_KIND, quote.revision]),
              JSON.stringify({ version: 1, source: "from the Hub", action: LEARN_KIND, revision: quote.revision, at: new Date(this.now()).toISOString(),
                jobId, checkout: root, agent: plan.agent, tokensEstimate: quote.tokens, ceilingTokens: quote.ceilingTokens, weekly: quote.weekly }),
            );
          });
          if (existing) throw staleQuote();
          step = hubSetupStep(stepFromRow(reader, job), job);
        } finally { writer.close(); }
        this.#approvals.delete(quote.revision);
        ensureBackground({ ...this.location, env: this.env, entry: this.entry });
        return step;
      } catch (error) {
        if (error instanceof SourceError || error instanceof HubRequestError && error.status === 409) {
          this.#approvals.delete(quote.revision);
          throw staleQuote();
        }
        throw error;
      }
    });
  }

  async skip(repoId: string, session: string, body: unknown) {
    return this.#run(repoId, async () => {
      const { quote, offerRevision, expires } = this.#approval(repoId, session, body);
      const writer = await waitForRecordWriter(this.location);
      try {
        writer.db.exec("BEGIN IMMEDIATE");
        try {
          this.#requireOffer(readWriter(writer), repoId, offerRevision);
          if (expires <= this.now()) throw staleQuote();
          writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,'true')").run(repoId, LEARNING_DISMISSED);
          writer.db.exec("COMMIT");
        } catch (error) {
          writer.db.exec("ROLLBACK");
          throw error;
        }
      } finally { writer.close(); }
      this.#approvals.delete(quote.revision);
      return { saved: true };
    });
  }

  #approval(repoId: string, session: string, body: unknown) {
    const parsed = MachineSetupLearningDecisionSchema.safeParse(body);
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid learning decision", "Open and confirm the current learning estimate.");
    const approval = this.#approvals.get(parsed.data.quoteRevision);
    if (!approval || approval.repoId !== repoId || approval.session !== session || approval.expires <= this.now()) throw staleQuote();
    return approval;
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

  #requireOffer(reader: OfferReader, repoId: string, revision: string) {
    const location = recordLocation({ ...this.location, create: false });
    const target = readStore(openHooksReadOnly, this.location, hooks => readSetupTarget(reader, hooks, location, repoId, this.now()));
    if (!target?.enabled || target.missing || target.run?.caller !== "person" || this.env.MEX_OFF === "1"
      || !isSameCheckout(target.checkout.path) || setupOfferRevision(target) !== revision
      || reader.setting(repoId, LEARNING_DISMISSED) === "true"
      || reader.get("SELECT 1 FROM jobs WHERE project_id=? AND kind=? LIMIT 1", repoId, LEARN_KIND)) throw staleQuote();
    return target.checkout.path;
  }
}
