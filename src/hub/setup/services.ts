import type {
  ActivityRequest,
  ActivityResponse,
  HealthResponse,
  HomeResponse,
  HubCapabilities,
  SearchRequest,
  SearchResponse,
} from "@mex/hub-contracts";
import type { OverviewResponse } from "@mex/hub-contracts/overview";
import type { SetupRun, SetupStartRequest, SetupStatus } from "@mex/hub-contracts/setup";
import { basename } from "node:path";
import { createRepositoryGitPort } from "../../team/git/git-port.js";
import type { HubReadServices } from "../app.js";
import { HubSetupRunner, setupSnapshotRevision, setupWorkbenchReason } from "./runner.js";

const UNAVAILABLE = setupWorkbenchReason();

export interface SetupHubServices {
  readonly services: HubReadServices;
  readonly setup: HubSetupRunner;
}

export interface CreateSetupHubServicesOptions {
  readonly onReady?: (signal: AbortSignal) => void | Promise<void>;
  readonly initialMode?: "code-repo" | "agent-memory";
}

export function createSetupHubServices(
  projectRoot: string,
  options: CreateSetupHubServicesOptions = {},
): SetupHubServices {
  const setup = new HubSetupRunner({
    projectRoot,
    initialMode: options.initialMode,
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
  });
  const git = createRepositoryGitPort(projectRoot);
  const now = () => new Date();

  const unavailableCapability = { availability: "unavailable" as const, reason: UNAVAILABLE };

  const services: HubReadServices = {
    async capabilities(): Promise<HubCapabilities> {
      let gitStatus: HubCapabilities["git"] = unavailableCapability;
      try {
        await git.getRepoState();
        gitStatus = { availability: "available" };
      } catch {
        gitStatus = { availability: "unavailable", reason: "Git repository state is not safely readable." };
      }
      return {
        apiVersion: "v1",
        git: gitStatus,
        activity: unavailableCapability,
        activityRecord: unavailableCapability,
        members: {
          read: unavailableCapability,
          canonicalMutation: unavailableCapability,
          localSelection: unavailableCapability,
        },
        workstreams: {
          read: unavailableCapability,
          canonicalMutation: unavailableCapability,
        },
        specs: { read: unavailableCapability },
        inbox: {
          read: unavailableCapability,
          draftMutation: unavailableCapability,
          proposalMutation: unavailableCapability,
          specApproval: unavailableCapability,
        },
        relays: {
          read: unavailableCapability,
          draftMutation: unavailableCapability,
          publish: unavailableCapability,
          lifecycleMutation: unavailableCapability,
        },
        jobs: unavailableCapability,
        graph: {
          read: unavailableCapability,
          refresh: unavailableCapability,
          rebuild: unavailableCapability,
        },
        wiki: {
          read: unavailableCapability,
          refresh: unavailableCapability,
          rebuild: unavailableCapability,
        },
      };
    },

    async home(): Promise<HomeResponse> {
      return projectSetupHome(projectRoot, git, now());
    },

    async overview(): Promise<OverviewResponse> {
      const observedAt = now().toISOString();
      const shell = await projectSetupHome(projectRoot, git, now());
      const unavailable = { availability: "unavailable" as const, observedAt, reason: UNAVAILABLE };
      return {
        observedAt,
        shell,
        identity: unavailable,
        focus: unavailable,
        activity: unavailable,
        context: unavailable,
        operation: unavailable,
      };
    },

    activity(_request: ActivityRequest): ActivityResponse {
      return {
        items: [],
        nextCursor: null,
        hasMore: false,
        sourceTruncated: false,
        deterministicRevision: setupSnapshotRevision("setup-activity"),
        diagnostics: [],
        diagnosticsTruncated: false,
      };
    },

    search(request: SearchRequest): SearchResponse {
      const unavailableGroup = {
        status: "unavailable" as const,
        items: [],
        nextCursor: null,
        truncated: false,
        revision: null,
        detail: UNAVAILABLE,
      };
      return {
        query: request.q,
        observedAt: now().toISOString(),
        groups: {
          wiki: unavailableGroup,
          symbols: unavailableGroup,
          sources: unavailableGroup,
        },
      };
    },

    health(): HealthResponse {
      return {
        status: "unavailable",
        observedAt: now().toISOString(),
        components: [
          {
            id: "git",
            label: "Git repository",
            status: "degraded",
            summary: UNAVAILABLE,
            diagnostics: [],
          },
        ],
      };
    },
  };

  return { services, setup };
}

export function projectSetupStatusPayload(setup: HubSetupRunner): Promise<SetupStatus> {
  return setup.status();
}

export function startSetupRun(setup: HubSetupRunner, request: SetupStartRequest): SetupRun {
  return setup.start(request);
}

async function projectSetupHome(
  projectRoot: string,
  git: ReturnType<typeof createRepositoryGitPort>,
  observed: Date,
): Promise<HomeResponse> {
  const observedAt = observed.toISOString();
  let branch: string | null = null;
  let head: string | null = null;
  let dirty = false;
  try {
    const repo = await git.getRepoState();
    branch = repo.branch;
    head = repo.head;
    dirty = repo.dirty;
  } catch {
    // Setup mode must still render a shell when git is missing.
  }
  return {
    observedAt,
    repository: {
      scaffoldId: "setup-pending",
      name: basename(projectRoot),
      branch,
      head,
      dirty,
    },
    actor: { kind: "unknown" },
    attention: {
      inbox: { availability: "unavailable", reason: UNAVAILABLE },
      relays: { availability: "unavailable", reason: UNAVAILABLE },
    },
    jobs: { availability: "unavailable", reason: UNAVAILABLE },
  };
}
