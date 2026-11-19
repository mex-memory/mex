import { recordLocation } from "../record/location.js";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { acceptCompact, compactStates, prepareCompact, undoManagedCompaction, type CompactSelection } from "./control.js";
import { compactEvidence, compactModel, findWindowOffer } from "./evidence.js";

interface Options { agent?: string; model?: string; scope?: string; choice?: string; offer?: string; json?: boolean }

export async function runCompact(action: string | undefined, options: Options) {
  if (action !== undefined && action !== "accept" && action !== "off") throw new Error("Use mex compact, mex compact accept, or mex compact off.");
  const agent = options.agent ?? "claude-code";
  if (agent !== "claude-code" && agent !== "codex") throw new Error("Choose --agent claude-code or --agent codex.");
  const scope = options.scope ?? (agent === "codex" ? "repo" : "user");
  const choice = options.choice ?? "window";
  if (scope !== "user" && scope !== "repo") throw new Error("Choose --scope user or --scope repo.");
  if (choice !== "window" && choice !== "idle" && choice !== "post-turn") throw new Error("Choose --choice window, idle, or post-turn.");
  if (action !== "off") {
    if (agent === "codex" && scope === "user") throw new Error("Codex compaction settings use repo scope.");
    if (agent === "codex" && choice === "idle") throw new Error("The idle offer is available for Claude Code.");
    if (agent === "claude-code" && choice === "post-turn") throw new Error("The post-turn offer is available for Codex.");
  }
  const location = recordLocation({ create: false });
  const reader = openRecordReadOnly({ home: location.home });
  if (!reader) throw new Error("Turn MEX on in this repo first.");
  let writer: RecordWriter | undefined;
  try {
    if (reader.diagnostic) throw new Error(reader.diagnostic);
    const checkout = reader.checkout(process.cwd())?.path;
    if (action === "off") {
      if (!checkout && options.scope === "repo") throw new Error("Run mex compact off --scope repo in a checkout registered with MEX.");
      const record = writer = openRecord({ home: location.home });
      const result = await withContainedArtifactLock(location.home, "install", ".install.lock", () =>
        undoManagedCompaction(record, { checkout, agent: options.agent ? agent : undefined, scope: !checkout ? "user" : options.scope ? scope : undefined,
          choice: options.choice ? choice : undefined, model: options.model ? compactModel(options.model, agent) : undefined }));
      if (options.json) console.log(JSON.stringify(result));
      else {
        for (const path of result.restored) console.log(`Restored previous compaction settings in ${path}.`);
        for (const path of result.conflicts) console.error(`Compaction settings changed in ${path}. Review the file and retry.`);
        if (!result.restored.length && !result.conflicts.length) console.log("No matching compaction settings to restore.");
      }
      if (result.conflicts.length) process.exitCode = 1;
      return;
    }
    if (!checkout) throw new Error("Run mex compact in a checkout registered with MEX.");
    const state = compactStates(reader, checkout);
    const observations = compactEvidence(location, agent, scope === "repo" ? checkout : undefined);
    const match = findWindowOffer(observations, agent, options.model);
    const model = match?.model, evidence = match?.evidence;
    if (!model || !evidence) {
      if (action === "accept") throw new Error("A current eligible compaction offer is required.");
      if (options.json) console.log(JSON.stringify({ state, offer: null }));
      else {
        for (const saved of state) console.log(`${saved.agent} ${saved.model} is ${saved.state}${saved.reason ? ` (${saved.reason})` : ""}.`);
        console.log("The window offer needs three measured sessions above 300k on a 1M model and a measured post-compaction size.");
      }
      return;
    }
    const request: CompactSelection = { agent, checkout, model, scope, choice,
      // Codex supplies its usable capacity in the token-count event.
      value: choice === "idle" ? 150_000 : choice === "post-turn" ? Math.round(100 * evidence.window / evidence.capacity) : evidence.window };
    if (action === "accept") {
      if (!options.offer) throw new Error("Review mex compact first, then pass its offer ID with --offer.");
      writer = openRecord({ home: location.home });
      const changed = await acceptCompact(writer, request, options.offer);
      if (changed) {
        const { ensureBackground } = await import("../record/background.js");
        ensureBackground({ home: location.home, force: true });
      }
      if (options.json) console.log(JSON.stringify({ applied: changed }));
      else console.log(changed ? "Saved the compaction setting. Use mex compact off to restore the previous value." : "That compaction setting already has the offered value.");
      return;
    }
    const offer = prepareCompact(request);
    if (options.json) console.log(JSON.stringify({ offer: offer.offer, path: offer.path, ...request, evidence, state }));
    else {
      for (const saved of state) console.log(`${saved.agent} ${saved.model} is ${saved.state}${saved.reason ? ` (${saved.reason})` : ""}.`);
      console.log(`${model}: ${evidence.sessions} sessions above 300k. Measured median post-compaction context ${evidence.postCompaction.toLocaleString()} tokens from ${evidence.samples} sessions.`);
      console.log(`Offer ${offer.offer} sets ${choice} to ${request.value.toLocaleString()}${choice === "post-turn" ? "% of usable context" : " tokens"} in ${offer.path}.`);
      console.log(`To accept, run mex compact accept --offer ${offer.offer} --agent ${agent} --model ${model} --scope ${scope} --choice ${choice}`);
    }
  } finally { writer?.close(); reader.close(); }
}
