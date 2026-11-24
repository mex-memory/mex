// The joined fixture's checks, as pure functions, so each one can be shown
// to fail with its join's name when that join breaks (joins.test.ts).

export class JoinError extends Error {}

export function requireJoin(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JoinError(message);
}

export interface Receipt { entry_id: string; surface: string; action: string; block_id: string; form: string; }

export interface SetupJob { kind: string; state: string; reason: string | null; }

/** Bare `mex` finished the setup steps the rest of the chain reads. */
export function checkSetupJobs(jobs: SetupJob[], kinds: string[]): void {
  for (const kind of kinds) {
    const row = jobs.find(job => job.kind === kind);
    requireJoin(row?.state === "done", `bare mex did not finish its ${kind} job (${row?.state ?? "missing"}${row?.reason ? `: ${row.reason}` : ""})`);
  }
}

/** The producer gate accepted a proposal. */
export function checkAccepted(result: { status?: string; entryId?: string } | undefined, what: string): string {
  requireJoin(result?.status === "accepted" && result.entryId, `the gate did not accept the ${what} proposal: ${JSON.stringify(result)}`);
  return result.entryId;
}

/** A card about the symbol, with the code body it should carry. */
export function checkCard(context: string, agent: string, surface: string, file: string, symbol: string, body: string): void {
  requireJoin(context, `${agent} returned no context for ${symbol} with ${surface} enabled`);
  requireJoin(context.includes(`${file}:`) && context.includes(symbol) && context.includes(body), `${agent} sent no ${surface} card for ${symbol}`);
}

/** The delivered block has a matching receipt. */
export function checkReceipt(context: string, receipts: Receipt[], agent: string, surface: string): void {
  requireJoin(receipts.some(row => row.action === "given" && row.surface === surface && row.block_id && context.includes(`[mex ${row.block_id}]`)),
    `${agent} has no ${surface} receipt for the delivered block`);
}

/** Withheld, or sent only as a pointer to today's code: never restated. */
export function checkKept(context: string, receipts: Receipt[], id: string, text: string, when: string): void {
  requireJoin(!context.includes(text), `entry ${id} was restated ${when}`);
  requireJoin(receipts.some(row => row.entry_id === id && (row.action === "withheld" || row.form === "pointer")),
    `entry ${id} was not withheld or reduced to a pointer ${when}`);
}

export interface ProbeAnswer { id?: string; verdict?: string; form?: string; text?: string; }

/** What the controller would send for an entry now, at any moment. */
export function checkProbe(probe: { ok?: boolean; results?: ProbeAnswer[] }, id: string, text: string, when: string): void {
  const answer = probe.results?.find(row => row.id === id) ?? probe.results?.[0];
  requireJoin(probe.ok && answer && (answer.form === "withheld" || answer.form === "pointer") && !String(answer.text ?? "").includes(text),
    `entry ${id} would still be sent in full ${when} (${answer?.verdict ?? "no verdict"}, ${answer?.form ?? "no form"})`);
}
