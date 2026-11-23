import type { MeaningQuestion, MeaningVerdict } from "../../meaning.js";

export function meaningQuestions(prompt: string): Array<MeaningQuestion & { index: number }> {
  return JSON.parse(prompt.split("\n").at(-1)!);
}

export function recordedMeaning(prompt: string, verdict: (question: MeaningQuestion) => MeaningVerdict =
  question => "lesson" in question ? "same" : "supports") {
  return { results: meaningQuestions(prompt).map(question => [question.index, verdict(question)]) };
}
