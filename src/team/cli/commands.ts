import { MexPortError } from "../contracts/shared.js";
import { TEAM_READ_LIMITS } from "../contracts/workflow.js";
import { isArtifactId } from "../artifacts/ulid.js";
import {
  exitCodeForTeamEnvelope,
  notFoundProblem,
  renderTeamEnvelope,
  teamEnvelope,
  teamProblemEnvelope,
  TeamCliUsageError,
  type TeamCliCommandName,
  type TeamCliEnvelope,
  type TeamCliExitCode,
  type TeamCliMode,
} from "./envelope.js";
import {
  projectActivity,
  projectActivityPage,
  projectApply,
  projectCurrentActor,
  projectMember,
  projectMemberPage,
  projectPreview,
  projectWorkstream,
  projectWorkstreamApply,
  projectWorkstreamPage,
  projectWorkstreamPreview,
  type TeamActivityProjection,
  type TeamApplyProjection,
  type TeamCurrentActorProjection,
  type TeamMemberProjection,
  type TeamPageProjection,
  type TeamWorkstreamApplyProjection,
  type TeamWorkstreamProjection,
} from "./projections.js";
import {
  readTeamCommandFile,
  readTeamPreviewFile,
  type TeamIdentityActivityMutationCommandName,
  type TeamWorkstreamMutationCommandName,
} from "./request-file.js";
import type {
  TeamIdentityActivityCliService,
  TeamIdentityActivityCliServiceFactory,
  TeamWorkstreamCliService,
  TeamWorkstreamCliServiceFactory,
} from "./service.js";
import { WORKSTREAM_STATES, type WorkstreamState } from "../contracts/workflow.js";

const MAX_CURSOR_BYTES = 4 * 1024;

export interface TeamCommandIo {
  write(line: string): void;
  setExitCode(code: TeamCliExitCode): void;
}

export interface TeamOutputFlags {
  json?: boolean;
}

export interface TeamPageFlags extends TeamOutputFlags {
  cursor?: string;
  limit?: string | number;
}

export interface MemberListFlags extends TeamPageFlags {
  active?: boolean;
  inactive?: boolean;
}

export interface ActivityListFlags extends TeamPageFlags {
  since?: string;
}

export interface WorkstreamListFlags extends TeamPageFlags {
  state?: string | readonly string[];
  includeArchived?: boolean;
}

export interface TeamMutationFlags extends TeamOutputFlags {
  apply?: string;
}

export type TeamCliServiceSource =
  | TeamIdentityActivityCliService
  | TeamIdentityActivityCliServiceFactory;

export type TeamWorkstreamCliServiceSource =
  | TeamWorkstreamCliService
  | TeamWorkstreamCliServiceFactory;

export async function runMemberList(
  source: TeamCliServiceSource,
  flags: MemberListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("member.list", "read", flags, io, async () => {
    if (flags.active === true && flags.inactive === true) {
      throw new TeamCliUsageError("--active and --inactive cannot be used together.");
    }
    const service = await resolveService(source);
    const projected = projectMemberPage(await service.listMembers({
      ...(flags.active === true ? { active: true } : {}),
      ...(flags.inactive === true ? { active: false } : {}),
      ...pageRequest(flags),
    }));
    return teamEnvelope({
      command: "member.list",
      mode: "read",
      data: projected.data,
      diagnostics: projected.diagnostics,
    });
  }, renderMemberList);
}

export async function runMemberShow(
  source: TeamCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("member.show", "read", flags, io, async () => {
    assertArtifactId(id, "member");
    const member = await (await resolveService(source)).getMember(id);
    if (member === null) throw new MexPortError(notFoundProblem("member", id));
    return teamEnvelope({
      command: "member.show",
      mode: "read",
      data: projectMember(member),
    });
  }, renderMember);
}

export async function runMemberCurrent(
  source: TeamCliServiceSource,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("member.current", "read", flags, io, async () => {
    const projected = projectCurrentActor(await (await resolveService(source)).getCurrentActor());
    return teamEnvelope({
      command: "member.current",
      mode: "read",
      data: projected.data,
      diagnostics: projected.diagnostics,
    });
  }, renderCurrentActor);
}

export async function runActivityList(
  source: TeamCliServiceSource,
  flags: ActivityListFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("activity.list", "read", flags, io, async () => {
    if (flags.since !== undefined) assertIsoTimestamp(flags.since, "--since");
    const service = await resolveService(source);
    const projected = projectActivityPage(await service.listActivity({
      ...(flags.since === undefined ? {} : { since: flags.since }),
      ...pageRequest(flags),
    }));
    return teamEnvelope({
      command: "activity.list",
      mode: "read",
      data: projected.data,
      diagnostics: projected.diagnostics,
    });
  }, renderActivityList);
}

export async function runActivityShow(
  source: TeamCliServiceSource,
  id: string,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
): Promise<void> {
  await execute("activity.show", "read", flags, io, async () => {
    assertArtifactId(id, "event");
    const activity = await (await resolveService(source)).getActivity(id);
    if (activity === null) throw new MexPortError(notFoundProblem("activity", id));
    return teamEnvelope({
      command: "activity.show",
      mode: "read",
      data: projectActivity(activity),
    });
  }, renderActivity);
}

export async function runTeamMutation(
  source: TeamCliServiceSource,
  command: TeamIdentityActivityMutationCommandName,
  requestFile: string | undefined,
  flags: TeamMutationFlags,
  io: TeamCommandIo,
): Promise<void> {
  if (flags.apply === undefined) {
    await execute(command, "preview", flags, io, async () => {
      if (requestFile === undefined) {
        throw new TeamCliUsageError("A mutation request JSON file is required for preview.");
      }
      const request = readTeamCommandFile(requestFile, command);
      const preview = projectPreview(
        await (await resolveService(source)).previewIdentityActivity(request),
      );
      return teamEnvelope({
        command,
        mode: "preview",
        data: preview,
        diagnostics: preview.preview.diagnostics,
        valid: preview.preview.valid,
      });
    }, renderPreview);
    return;
  }

  const applyFile = flags.apply;
  await execute(command, "apply", flags, io, async () => {
    if (requestFile !== undefined) {
      throw new TeamCliUsageError(
        "Apply accepts only --apply <preview-envelope.json>; do not also pass a request file.",
      );
    }
    const preview = readTeamPreviewFile(applyFile, command);
    const result = projectApply(
      await (await resolveService(source)).applyIdentityActivity(preview),
    );
    return teamEnvelope({ command, mode: "apply", data: result });
  }, renderApply);
}

async function execute<T>(
  command: TeamCliCommandName,
  mode: TeamCliMode,
  flags: TeamOutputFlags,
  io: TeamCommandIo,
  operation: () => Promise<TeamCliEnvelope<T>>,
  human: (data: T, envelope: TeamCliEnvelope<T>, io: TeamCommandIo) => void,
): Promise<void> {
  let envelope: TeamCliEnvelope<T> | TeamCliEnvelope<never>;
  try {
    envelope = await operation();
  } catch (error) {
    envelope = teamProblemEnvelope(command, mode, error);
  }
  if (flags.json === true) {
    io.write(renderTeamEnvelope(envelope));
  } else if (envelope.data === null) {
    renderFailure(envelope, io);
  } else {
    human(envelope.data as T, envelope as TeamCliEnvelope<T>, io);
    renderDiagnostics(envelope, io);
  }
  io.setExitCode(exitCodeForTeamEnvelope(envelope));
}

function pageRequest(flags: TeamPageFlags): { cursor?: string; limit?: number } {
  if (flags.cursor !== undefined && Buffer.byteLength(flags.cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw new TeamCliUsageError(`--cursor exceeds ${MAX_CURSOR_BYTES} bytes.`);
  }
  return {
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(flags.limit === undefined ? {} : { limit: positiveLimit(flags.limit) }),
  };
}

function positiveLimit(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > TEAM_READ_LIMITS.maxPageSize
  ) {
    throw new TeamCliUsageError(
      `--limit must be an integer from 1 to ${TEAM_READ_LIMITS.maxPageSize}.`,
    );
  }
  return parsed;
}

async function resolveService(
  source: TeamCliServiceSource,
): Promise<TeamIdentityActivityCliService> {
  return typeof source === "function" ? source() : source;
}

function assertArtifactId(id: string, prefix: "member" | "event" | "ws"): void {
  if (!isArtifactId(id, prefix)) {
    throw new TeamCliUsageError(`${prefix} ID must be a ${prefix}_ prefixed ULID.`);
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TeamCliUsageError(`${label} must be an exact UTC ISO-8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TeamCliUsageError(`${label} must be an exact UTC ISO-8601 timestamp.`);
  }
}

function renderMemberList(
  page: TeamPageProjection<TeamMemberProjection>,
  _envelope: TeamCliEnvelope<TeamPageProjection<TeamMemberProjection>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No members found.");
  for (const member of page.items) {
    io.write(`${member.id}\t${member.active ? "active" : "inactive"}\t${member.displayName}`);
  }
  renderContinuation(page, io);
}

function renderMember(
  member: TeamMemberProjection,
  _envelope: TeamCliEnvelope<TeamMemberProjection>,
  io: TeamCommandIo,
): void {
  io.write(`${member.displayName} (${member.id})`);
  io.write(`State: ${member.active ? "active" : "inactive"}`);
  io.write(`Revision: ${member.revision}`);
  for (const alias of member.gitAliases) {
    io.write(`Git alias: ${alias.name ?? "-"} <${alias.email ?? "-"}>`);
  }
}

function renderCurrentActor(
  current: TeamCurrentActorProjection,
  _envelope: TeamCliEnvelope<TeamCurrentActorProjection>,
  io: TeamCommandIo,
): void {
  if (current.actor.kind === "member") {
    io.write(`${current.actor.displayName ?? current.actor.memberId} (${current.source})`);
  } else if (current.actor.kind === "git") {
    io.write(`${current.actor.name ?? "unknown"} <${current.actor.email ?? "unknown"}> (${current.source})`);
  } else {
    io.write(`Unknown actor (${current.source})`);
  }
  io.write(current.selection === null
    ? "Local member selection: none"
    : `Local member selection: ${current.selection.memberId}`);
}

function renderActivityList(
  page: TeamPageProjection<TeamActivityProjection>,
  _envelope: TeamCliEnvelope<TeamPageProjection<TeamActivityProjection>>,
  io: TeamCommandIo,
): void {
  if (page.items.length === 0) io.write("No Activity events found.");
  for (const activity of page.items) {
    io.write(`${activity.timestamp}\t${activity.id}\t${activity.action}`);
  }
  renderContinuation(page, io);
}

function renderActivity(
  activity: TeamActivityProjection,
  _envelope: TeamCliEnvelope<TeamActivityProjection>,
  io: TeamCommandIo,
): void {
  io.write(`${activity.action} (${activity.id})`);
  io.write(`Occurred: ${activity.timestamp}`);
  io.write(`Subjects: ${activity.subjects.length}`);
  io.write(`Repository: ${activity.repoState.branch ?? "detached"} @ ${activity.repoState.head ?? "unborn"}${activity.repoState.dirty ? " (dirty)" : ""}`);
}

function renderWorkstream(
  workstream: TeamWorkstreamProjection,
  _envelope: TeamCliEnvelope<TeamWorkstreamProjection>,
  io: TeamCommandIo,
): void {
  io.write(`${workstream.title} (${workstream.id})`);
  io.write(`State: ${workstream.state}`);
  io.write(`Current: ${workstream.currentState}`);
  io.write(`Next milestone: ${workstream.nextMilestone}`);
  io.write(`Revision: ${workstream.revision}`);
}

function renderPreview(
  preview: ReturnType<typeof projectPreview>,
  envelope: TeamCliEnvelope<ReturnType<typeof projectPreview>>,
  io: TeamCommandIo,
): void {
  io.write(`${envelope.ok ? "Valid" : "Invalid"} ${preview.preview.scope} preview for ${preview.request.operationId}`);
  io.write(`Canonical changes: ${preview.preview.changes.length}`);
  io.write(`Local changes: ${preview.preview.localChanges.length}`);
  io.write(`Preview revision: ${preview.receipt.previewRevision}`);
  io.write("Use --json to save this complete approval envelope before apply.");
}

function renderWorkstreamPreview(
  preview: ReturnType<typeof projectWorkstreamPreview>,
  envelope: TeamCliEnvelope<ReturnType<typeof projectWorkstreamPreview>>,
  io: TeamCommandIo,
): void {
  io.write(`${envelope.ok ? "Valid" : "Invalid"} ${preview.preview.scope} preview for ${preview.request.operationId}`);
  io.write(`Canonical changes: ${preview.preview.changes.length}`);
  io.write(`Local changes: ${preview.preview.localChanges.length}`);
  io.write(`Preview revision: ${preview.receipt.previewRevision}`);
  io.write("Use --json to save this complete approval envelope before apply.");
}

function renderApply(
  result: TeamApplyProjection,
  _envelope: TeamCliEnvelope<TeamApplyProjection>,
  io: TeamCommandIo,
): void {
  io.write(`${result.idempotentReplay ? "Replayed" : "Applied"} ${result.operationId}`);
  io.write(`Canonical changes: ${result.changes.length}`);
  io.write(`Local changes: ${result.localChanges.length}`);
  io.write(`Activity events: ${result.events.length}`);
}

function renderWorkstreamApply(
  result: TeamWorkstreamApplyProjection,
  _envelope: TeamCliEnvelope<TeamWorkstreamApplyProjection>,
  io: TeamCommandIo,
): void {
  io.write(`${result.idempotentReplay ? "Replayed" : "Applied"} ${result.operationId}`);
  io.write(`Canonical changes: ${result.changes.length}`);
  io.write(`Workstreams: ${result.workstreams.length}`);
  io.write(`Activity events: ${result.events.length}`);
}

function renderContinuation(
  page: { nextCursor: string | null; sourceTruncated: boolean },
  io: TeamCommandIo,
): void {
  if (page.nextCursor !== null) io.write(`Next cursor: ${page.nextCursor}`);
  if (page.sourceTruncated) io.write("Warning: the bounded source scan was incomplete.");
}

function renderDiagnostics(
  envelope: TeamCliEnvelope<unknown>,
  io: TeamCommandIo,
): void {
  for (const diagnostic of envelope.diagnostics) {
    io.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }
}

function renderFailure(
  envelope: TeamCliEnvelope<unknown>,
  io: TeamCommandIo,
): void {
  if (envelope.problem === null) {
    io.write("Team command failed validation.");
  } else {
    io.write(`${envelope.problem.code}: ${envelope.problem.detail}`);
    for (const recovery of envelope.problem.recovery ?? []) {
      io.write(`Next: ${recovery.command ?? recovery.route ?? recovery.label}`);
    }
  }
  renderDiagnostics(envelope, io);
}
