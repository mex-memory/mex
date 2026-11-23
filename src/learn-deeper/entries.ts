import type { Proposal } from "../knowledge/gate.js";

export type WriterModel = Exclude<Proposal["model"], "none">;
