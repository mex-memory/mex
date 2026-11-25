import { MachineSetupAnswerRequestSchema, type MachineSetupQuestion } from "@mex/hub-contracts/machine";
import { queueNativeRebuild } from "../../knowledge/native-queue.js";
import { ensureBackground } from "../../record/background.js";
import { openHooksReadOnly, openRecordReadOnly } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { waitForRecordWriter } from "../../record/writer-wait.js";
import { applySetupAnswers } from "../../repo-start/questions/index.js";
import { readSetupStepRows, setupStepCheckout } from "../../repo-start/steps.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";
import { readSetupQuestions } from "./setup-questions.js";
import { readSetupFacts, readSetupTarget, setupOfferRevision } from "./setup-snapshot.js";

const stale = () => new HubRequestError(409, "REVISION_CONFLICT", "Setup questions changed", "Check the current questions and try again.");

export async function answerHubSetup(
  location: LocationOptions, now: () => number, env: NodeJS.ProcessEnv, entry: string | undefined, repoId: string, body: unknown,
) {
  const parsed = MachineSetupAnswerRequestSchema.safeParse(body);
  if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid answer", "Choose a current question and one of its answers.");
  const request = parsed.data;
  const refs = request.action === "answer" ? [request.question] : request.questions;
  if (new Set(refs.map(({ id }) => id)).size !== refs.length) throw stale();
  const writer = await waitForRecordWriter(location);
  try {
    const data = readStore(openRecordReadOnly, location, reader => readStore(openHooksReadOnly, location, hooks => {
      const target = reader && readSetupTarget(reader, hooks, writer.location, repoId, now());
      if (!reader || !target?.enabled || target.missing || env.MEX_OFF === "1") throw stale();
      const row = readSetupStepRows(reader, repoId).find(({ kind }) => kind === "code-facts");
      const facts = readSetupFacts(writer.location, target, row && setupStepCheckout(row));
      return readSetupQuestions(writer.location, repoId, target.checkout.path, setupOfferRevision(target), facts);
    }));
    if (request.action === "skipAll" && data.questions.length !== refs.length) throw stale();
    const reply = request.action === "answer" ? request.choice : "skip";
    const outcomes = await applySetupAnswers({ ...data.input, env, now: new Date(now()) }, refs.map(({ id, revision }) => {
      const question = data.questions.find(({ gap, view }) => gap.id === id && view.revision === revision);
      if (!question) throw stale();
      if (reply !== "skip" && !question.gap.choices.some(({ key }) => key === reply)) {
        throw new HubRequestError(400, "INVALID_REQUEST", "Invalid answer", "Choose one of the question’s answers.");
      }
      return { gap: question.gap, reply };
    }), writer);
    if (!outcomes) throw stale();
    if (outcomes.some(({ status }) => status === "saved" || status === "noted")) {
      queueNativeRebuild(data.input.root, {}, location);
      ensureBackground({ ...location, env, entry });
    }
    const questions = outcomes.map((outcome): MachineSetupQuestion => {
      const view = data.questions.find(({ gap }) => gap === outcome.gap)!.view;
      return { ...view, outcome: outcome.status === "skipped" ? { status: "skipped" } : { status: outcome.status, line: outcome.line } };
    });
    return { questions };
  } finally { writer.close(); }
}
