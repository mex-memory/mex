import { Command } from "commander";
import {
  runActivityList,
  runActivityShow,
  runMemberCurrent,
  runMemberList,
  runMemberShow,
  runTeamMutation,
  type ActivityListFlags,
  type MemberListFlags,
  type TeamCommandIo,
  type TeamMutationFlags,
  type TeamOutputFlags,
  type WorkstreamListFlags,
} from "./commands.js";
import type {
  TeamIdentityActivityCliServiceFactory,
  TeamWorkstreamCliServiceFactory,
} from "./service.js";

export interface TeamIdentityActivityCommandBuilderOptions {
  service: TeamIdentityActivityCliServiceFactory;
  io: TeamCommandIo;
}

/** Build, but do not register, the `mex member` command tree. */
export function buildMemberCommand(
  options: TeamIdentityActivityCommandBuilderOptions,
): Command {
  const member = new Command("member")
    .description("Read and preview/apply team member identity changes");

  member.command("list")
    .description("List canonical team members")
    .option("--active", "Include only active members")
    .option("--inactive", "Include only inactive members")
    .option("--cursor <cursor>", "Continue a bounded result page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: MemberListFlags) => runMemberList(options.service, flags, options.io));

  member.command("show")
    .description("Show one canonical team member")
    .argument("<member-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runMemberShow(options.service, id, flags, options.io));

  member.command("current")
    .description("Show the effective actor and optional local member selection")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: TeamOutputFlags) => runMemberCurrent(options.service, flags, options.io));

  addMutation(member, "add", "Preview or apply a canonical member creation", "member.add", options);
  addMutation(member, "update", "Preview or apply a canonical member update", "member.update", options);
  addMutation(member, "deactivate", "Preview or apply member deactivation", "member.deactivate", options);
  addMutation(member, "reactivate", "Preview or apply restoring an inactive member", "member.reactivate", options);
  addMutation(
    member,
    "select",
    "Preview or apply selecting or clearing the local current member",
    "member.select",
    options,
  );
  return member;
}

/** Build, but do not register, the structured `mex activity` command tree. */
export function buildActivityCommand(
  options: TeamIdentityActivityCommandBuilderOptions,
): Command {
  const activity = new Command("activity")
    .description("Read and preview/apply canonical Activity events");

  activity.command("list")
    .description("List canonical Activity events")
    .option("--since <timestamp>", "Only events at or after an exact UTC timestamp")
    .option("--cursor <cursor>", "Continue a bounded result page")
    .option("--limit <n>", "Maximum results (1-100)")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (flags: ActivityListFlags) => runActivityList(options.service, flags, options.io));

  activity.command("show")
    .description("Show one canonical Activity event")
    .argument("<event-id>")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (id: string, flags: TeamOutputFlags) => runActivityShow(options.service, id, flags, options.io));

  addMutation(activity, "record", "Preview or apply direct canonical Activity recording", "activity.record", options);
  return activity;
}

export function buildTeamIdentityActivityCommands(
  options: TeamIdentityActivityCommandBuilderOptions,
): readonly [Command, Command] {
  return [buildMemberCommand(options), buildActivityCommand(options)];
}

/** Default process adapter for later root registration; tests inject their own. */
export function processTeamCommandIo(): TeamCommandIo {
  return {
    write: (line) => console.log(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function addMutation(
  parent: Command,
  name: string,
  description: string,
  kind: Parameters<typeof runTeamMutation>[1],
  options: TeamIdentityActivityCommandBuilderOptions,
): void {
  parent.command(name)
    .description(description)
    .argument("[request-file]", "Caller-authored schema v1 mutation request for preview")
    .option("--apply <preview-envelope>", "Apply the exact complete JSON envelope emitted by preview")
    .option("--json", "Emit the schema v1 Team envelope")
    .action(async (requestFile: string | undefined, flags: TeamMutationFlags) => {
      await runTeamMutation(options.service, kind, requestFile, flags, options.io);
    });
}
