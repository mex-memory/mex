import { MachineKnowledgeCheckoutSchema, type MachineKnowledgeCheckout } from "@mex/hub-contracts/machine";
import { openRecordReadOnly } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { badKnowledgeRequest, knowledgeMissing, repoMissing } from "./knowledge-list.js";
import { PROJECT_ID, registeredCheckout } from "./knowledge-snapshot.js";
import { machinePath } from "./machine-projects.js";
import { readStore } from "./read.js";

export function parseKnowledgeCheckout(input: unknown): MachineKnowledgeCheckout {
  const result = MachineKnowledgeCheckoutSchema.safeParse(input);
  if (!result.success || !PROJECT_ID.test(result.data.repoId) || !machinePath(result.data.checkout)) {
    throw badKnowledgeRequest("Choose a registered repo and checkout.");
  }
  return result.data;
}

/** Resolve only an exact, still present registration. No implicit project discovery. */
export function registeredKnowledgeCheckout(location: LocationOptions, { repoId, checkout }: MachineKnowledgeCheckout) {
  return readStore(openRecordReadOnly, location, reader => {
    if (!reader?.project(repoId)) throw repoMissing();
    if (!registeredCheckout(reader, repoId, checkout)) {
      throw knowledgeMissing("That checkout is no longer registered or its folder is missing.");
    }
    return { location: recordLocation({ ...location, create: false }), projectId: repoId, root: checkout };
  });
}
