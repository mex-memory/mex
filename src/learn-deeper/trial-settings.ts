import { setPolicy } from "../controls/index.js";
import type { RecordWriter } from "../record/index.js";

const trials = {
  "learning.stopCheck": ["MEX checks changed code against scoped prose rules in the background, within the 3% automatic allowance.", "MEX skips prose rule checks after Stop and spends no tokens on them."],
  "learning.procedures": ["Deep analysis can name procedures from co-changes, with up to five cheap calls within the 3% automatic allowance.", "Deep analysis skips procedure naming and spends no tokens on it."],
  "learning.prDecisions": ["MEX rule files ask for a Decisions section in PR descriptions. This adds no model call.", "MEX rule files omit the PR Decisions instruction. This costs no tokens."],
  "learning.alwaysOn": ["Your local MEX rule files load up to about 450 tokens of repo-wide learned rules in every session. This adds no model call.", "Repo-wide learned rules stay out of rule files; agents read them with mex recall. This costs no tokens."],
  "learning.deep.issues": ["Deep analysis can read qualifying closed issues within its estimated budget.", "Deep analysis skips closed issues and spends no tokens on them."],
} as const;

export type LearningTrial = keyof typeof trials;
export const learningTrials = Object.keys(trials) as LearningTrial[];

export function isLearningTrial(key: string): key is LearningTrial {
  return Object.hasOwn(trials, key);
}

export function setLearningTrial(writer: RecordWriter, key: LearningTrial, value: string, directory: string): { confirmation: string; project: string } {
  if (value !== "on" && value !== "off") throw new Error(`Use on or off for ${key}.`);
  const checkout = writer.checkout(directory);
  if (!checkout) throw new Error("MEX is not registered here. Run `mex` first.");
  setPolicy(writer, checkout.project_id, key, value === "on");
  return { confirmation: trials[key][value === "on" ? 0 : 1], project: checkout.project_id };
}
