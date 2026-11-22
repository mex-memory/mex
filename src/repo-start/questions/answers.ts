/**
 * What the person answered at setup, kept beside the project's other setup files
 * (setup-answers.json). A question asked once is never asked again while its evidence
 * stays the same: its id is a hash of what setup found, so new evidence is a new question.
 * Entries made from answers live in the knowledge store; this file only remembers the
 * answer itself, including "skip" and answers that make no entry.
 */
import type { RecordLocation } from "../../record/location.js";
import { readFactFile, writeFactFile } from "../facts.js";

export type GapType = "rule-conflict" | "test-command" | "layer-exception" | "hand-edited";
export interface StoredAnswer {
  type: GapType;
  /** The choice key, or "skip". */
  choice: string;
  /** What the answer was about, for readers that act on it (code facts, setup recipes). */
  subject: string;
  at: string;
  /** Entries the answer made. */
  entries?: string[];
}
export interface AnswersFile { version: 1; answers: Record<string, StoredAnswer>; }

const FILE = "setup-answers.json";
/** The hand-edited question's "hand edits are fine" choice. */
export const HAND_EDITS_FINE = "2";
/** Bounded, like every setup file: the oldest answers go first. */
const MAX_ANSWERS = 500;

export function readAnswers(location: RecordLocation, projectId: string): AnswersFile {
  const file = readFactFile<AnswersFile>(location, projectId, FILE);
  return file?.version === 1 && file.answers && typeof file.answers === "object" ? file : { version: 1, answers: {} };
}

export function saveAnswer(location: RecordLocation, projectId: string, id: string, answer: StoredAnswer): void {
  const file = readAnswers(location, projectId);
  file.answers[id] = answer;
  const ids = Object.keys(file.answers);
  if (ids.length > MAX_ANSWERS) {
    for (const old of ids.sort((a, b) => file.answers[a]!.at.localeCompare(file.answers[b]!.at)).slice(0, ids.length - MAX_ANSWERS)) delete file.answers[old];
  }
  writeFactFile(location, projectId, FILE, file);
}

/** Generated files the person said are fine to edit by hand: code facts keeps no pitfall for them. */
export function answeredHandEdits(location: RecordLocation, projectId: string): Set<string> {
  try {
    return new Set(Object.values(readAnswers(location, projectId).answers)
      .filter(answer => answer.type === "hand-edited" && answer.choice === HAND_EDITS_FINE).map(answer => answer.subject));
  } catch { return new Set(); }
}

/** Packages whose test command the person chose: setup recipes leave that command to the answer's entry. */
export function answeredTestCommands(location: RecordLocation, projectId: string): Set<string> {
  try {
    return new Set(Object.values(readAnswers(location, projectId).answers)
      .filter(answer => answer.type === "test-command" && answer.choice !== "skip").map(answer => answer.subject));
  } catch { return new Set(); }
}
