import type { MeaningQuestion, MeaningVerdict } from "../../meaning.js";

export function meaningQuestions(prompt: string): Array<MeaningQuestion & { index: number }> {
  const { lessons, items } = JSON.parse(prompt.split("\n").at(-1)!) as {
    lessons: Array<{ lesson: string; claim?: string }>;
    items: Array<[number, number] | [string, string] | [number, number, number] | [number, string, string]>;
  };
  return items.map((item, offset) => {
    const [index, first, second] = item.length === 3 ? item : [offset, ...item] as const;
    return typeof first === "number" && typeof second === "number"
      ? { index, lesson: { left: lessons[first]!, right: lessons[second]! } }
      : { index, clause: String(first), quote: String(second) };
  });
}

export function recordedMeaning(prompt: string, verdict: (question: MeaningQuestion) => MeaningVerdict =
  question => "lesson" in question ? "same" : "supports") {
  return { results: meaningQuestions(prompt).map(question => [question.index, verdict(question)]) };
}
