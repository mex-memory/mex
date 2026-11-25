import { MachineSetupStepActionSchema } from "@mex/hub-contracts/machine";
import { ensureBackground, markPending } from "../../record/background.js";
import { openRecordReadOnly, type RecordWriter } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { waitForRecordWriter } from "../../record/writer-wait.js";
import type { JobRow } from "../../record/jobs.js";
import { actOnStep, readSetupStepRows } from "../../repo-start/steps.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";
import { hubSetupStep, stepRevision } from "./setup-snapshot.js";

const missing = () => new HubRequestError(404, "INVALID_REQUEST", "Setup step not found", "Open the repo’s current setup steps.");
const stale = () => new HubRequestError(409, "REVISION_CONFLICT", "The setup step changed", "Check its current status and try again.");

export async function changeSetupStep(
  location: LocationOptions, env: NodeJS.ProcessEnv | undefined, entry: string | undefined, repoId: string, id: string, body: unknown,
) {
  const parsed = MachineSetupStepActionSchema.safeParse(body);
  if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid setup action", "Choose an action and provide the current step revision.");
  const { action, expectedRevision } = parsed.data;
  const before = readStore(openRecordReadOnly, location, reader => reader?.get<JobRow>("SELECT * FROM jobs WHERE project_id=? AND id=?", repoId, id));
  if (!before) throw missing();

  const writer = await waitForRecordWriter(location);
  let step;
  try {
    step = actOnStep(writer, id, action, current => {
      if (!isCurrentStep(writer, repoId, id) || stepRevision(current, current.request) !== expectedRevision) throw stale();
      const allowed = action === "resume" ? current.state === "paused"
        : ["queued", "running", "waiting"].includes(current.state) || (action === "cancel" && current.state === "paused");
      if (!allowed || current.request) throw stale();
    });
    if (action === "resume") markPending(writer);
  } finally { writer.close(); }

  if (action === "resume") ensureBackground({ ...location, env, entry });
  return hubSetupStep(step, { ...before, state: step.state });
}

function isCurrentStep(writer: RecordWriter, repoId: string, id: string) {
  return readSetupStepRows({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, repoId)
    .some(row => row.id === id);
}
