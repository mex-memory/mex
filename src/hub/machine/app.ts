import {
  MachineAgentIdSchema, MachineAgentRepairRequestSchema, MachineJobActionRequestSchema, MachineSettingsApplyRequestSchema,
} from "@mex/hub-contracts/machine";
import { Hono, type Context } from "hono";
import { generateCookie, getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../../record/index.js";
import { recordLocation, type LocationOptions } from "../../record/location.js";
import { readBoundedJson, readStrictQuery } from "../http/request.js";
import { validateHubRequestPath, type HubAssetManifest } from "../static/assets.js";
import { AgentRepair, machineBusy } from "./agent-repair.js";
import { refreshedAgent, takeAgentsSnapshot, type MachineAgentOptions } from "./agents-snapshot.js";
import { ControlSnapshot } from "./control-snapshot.js";
import { HubEvents } from "./events.js";
import { HomeData } from "./home.js";
import { changeHubJob, readHubJobs } from "./jobs.js";
import { KnowledgeData } from "./knowledge.js";
import { KnowledgeBriefs } from "./knowledge-brief.js";
import { parseKnowledgeCheckout } from "./knowledge-checkout.js";
import { readKnowledgeItem } from "./knowledge-detail.js";
import { readForgotten } from "./knowledge-forgotten.js";
import { readKnowledgeLanding } from "./knowledge-landing.js";
import { readKnowledgePage } from "./knowledge-list.js";
import { RuleFilesData } from "./knowledge-rules.js";
import { KnowledgeConflict, KnowledgeReplays, KnowledgeWrites, knowledgeReadProblem, knowledgeWriteProblem } from "./knowledge-writes.js";
import { invalidReview, readReviewCard, readReviewPage, reviewUnavailable } from "./review.js";
import { ReviewProblem, ReviewWrites, reviewWriteProblem } from "./review-writes.js";
import type { ReviewDependencies } from "../../review/actions.js";
import { checkHost, checkWrite, HubRequestError, isBootstrapToken, type HubSession, type HubSessions, type RequestAddress } from "./security.js";
import { rotateHubSecret } from "./secret.js";
import { answerHubSetup } from "./setup-question-actions.js";
import { SetupLearning } from "./setup-learning.js";
import { changeSetupStep } from "./setup-step-actions.js";
import { SetupData, setupRepoId } from "./setup-data.js";
import { takeSettingsSnapshot } from "./settings-snapshot.js";
import { applyRecordSetting, applyTelemetrySetting, refreshCheckoutRules } from "./settings-writes.js";
import { takeUninstallSnapshot } from "./uninstall-snapshot.js";
import { consumeBootstrap, keepHubOpen, TAB_KEEPALIVE_MS, type HubMode } from "./state.js";

/**
 * The machine Hub's HTTP surface. Every request passes the Host check; every API request
 * except the handshake and sign-in needs a session; every write needs Origin plus CSRF.
 * Reads open record.db read-only; the few writes use a short-lived writer.
 */

export const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; "
  + "form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";

export interface MachineHubOptions extends LocationOptions {
  readonly sessions: HubSessions;
  readonly homeId: string;
  readonly version: string;
  readonly mode: HubMode;
  readonly assets?: HubAssetManifest;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly agentEntry?: string;
  readonly agentUserHome?: string;
  readonly reviewDependencies?: Partial<ReviewDependencies>;
}

interface Variables {
  requestId: string;
  address: RequestAddress;
  session: HubSession;
}

export function createMachineHubApp(options: MachineHubOptions) {
  const app = new Hono<{ Variables: Variables }>();
  const now = options.now ?? Date.now;
  const location: LocationOptions = { home: options.home, cache: options.cache, isNetwork: options.isNetwork };
  const hubHome = recordLocation({ ...location, create: false }).home;
  const requireHome = () => {
    if (!existsSync(hubHome)) throw new HubRequestError(410, "MISSING_HOME", "MEX’s home was removed", "Run mex hub from the terminal to start again.");
  };
  const withWriter = <T>(use: (writer: RecordWriter) => T): T => {
    requireHome();
    const writer = openRecord(location);
    try { return use(writer); } finally { writer.close(); }
  };

  const home = new HomeData(location, now);
  const knowledge = new KnowledgeData(location, now, options.env);
  const briefs = new KnowledgeBriefs(location, options.env);
  const ruleFiles = new RuleFilesData(location, now);
  const agentOptions: MachineAgentOptions = { ...location, env: options.env, entry: options.agentEntry, userHome: options.agentUserHome };
  const agentRead = new ControlSnapshot(now, signal => takeAgentsSnapshot(agentOptions, signal), "Agent settings couldn’t be read. Try again or run mex doctor.");
  const settingsRead = new ControlSnapshot(now,
    signal => takeSettingsSnapshot({ ...location, now, env: options.env, version: options.version, mode: options.mode }, signal),
    "The machine settings couldn’t be read. Try again or run mex doctor.");
  const uninstallRead = new ControlSnapshot(now, async signal => ({ ...await takeUninstallSnapshot(location, signal), issue: undefined }),
    "The install record couldn’t be read. Run mex uninstall --dry-run in your terminal.");
  const setup = new SetupData(location, now, options.env ?? process.env);
  const setupLearning = new SetupLearning(location, now, options.env ?? process.env, options.agentEntry);
  const repair = new AgentRepair(agentOptions, now);
  const followUps = new Set<NodeJS.Immediate>();
  const keepOpen = () => withWriter((writer) => keepHubOpen(writer, now() + TAB_KEEPALIVE_MS));
  const events = new HubEvents(location, home, knowledge, now, keepOpen, { agents: agentRead, settings: settingsRead, uninstall: uninstallRead, setup, ruleFiles });
  const changed = async (repoId: string, notesChanged: boolean) => {
    await home.refreshProject(repoId);
    if (notesChanged) await knowledge.refreshProject(repoId);
    events.reviewChanged(notesChanged);
  };
  const knowledgeWrites = new KnowledgeWrites(location, now, options.env, (repoId) => changed(repoId, true));
  const reviewWrites = new ReviewWrites(home, location, now, options.env, options.reviewDependencies, changed, knowledgeWrites);
  const knowledgeReplays = new KnowledgeReplays(now);
  const knowledgePost = async (context: Context<{ Variables: Variables }>, action: (body: unknown) => Promise<unknown>, status: 200 | 201 = 200) => {
    const body = await readBoundedJson(context.req.raw, 64 << 10);
    return knowledgeReplays.run(context.get("session").id, context.req.header("Idempotency-Key"), context.req.path, body, async () => {
      try { return context.json(await action(body), status); }
      catch (error) {
        if (error instanceof KnowledgeConflict) return problem(context, error, error.current && { current: error.current, attempted: error.attempted });
        return problem(context, knowledgeWriteProblem(error));
      }
    });
  };

  const machinePost = async (context: Context<{ Variables: Variables }>, action: (body: unknown) => Promise<unknown>) => {
    requireHome();
    const key = context.req.header("Idempotency-Key");
    if (!key) throw new HubRequestError(400, "INVALID_REQUEST", "Request key required", "Provide a request key for this action.");
    const body = await readBoundedJson(context.req.raw, 64 << 10);
    return knowledgeReplays.run(context.get("session").id, key, context.req.path, body, async () => {
      try { return context.json(await action(body)); }
      catch (error) {
        if (error instanceof Error && /^record\.db schema version \d+ is newer/u.test(error.message)) {
          return problem(context, new HubRequestError(409, "REVISION_CONFLICT", "MEX needs an upgrade", error.message));
        }
        return problem(context, machineBusy(error) ?? error);
      }
    });
  };
  const readAgentId = (id: string) => {
    const parsed = MachineAgentIdSchema.safeParse(id);
    if (!parsed.success) throw new HubRequestError(404, "INVALID_REQUEST", "Agent not found", "Choose a supported agent.");
    return parsed.data;
  };

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    context.set("requestId", requestId);
    try {
      context.set("address", checkHost(context.req.raw.headers, { env: options.env }));
    } catch (error) {
      const response = isPageNavigation(context) && error instanceof HubRequestError && error.title === "Wrong address"
        ? wrongAddressPage()
        : problem(context, error);
      applySecurityHeaders(response, requestId);
      return response;
    }
    await next();
    applySecurityHeaders(context.res, requestId);
  });

  app.onError((error, context) => {
    const response = problem(context, error);
    applySecurityHeaders(response, context.get("requestId") ?? randomUUID());
    return response;
  });

  // Unauthenticated: lets `mex hub` confirm that a port holds this home's Hub, of this version.
  app.get("/api/v1/hello", (context) => context.json({ app: "mex-hub", version: options.version, homeId: options.homeId, mode: options.mode }));

  app.post("/api/v1/session/bootstrap", async (context) => {
    checkWrite(context.req.raw.headers, context.get("address"), undefined);
    const body = await readBoundedJson(context.req.raw, 1_024) as { token?: unknown };
    const token = body?.token;
    if (!isBootstrapToken(token) || !withWriter((writer) => consumeBootstrap(writer, token, now()))) {
      throw new HubRequestError(401, "UNAUTHORIZED", "Sign-in link used or expired",
        "Each link works once, for 5 minutes. Run `mex hub` for a new one.");
    }
    const { session, cookie } = options.sessions.create();
    context.header("set-cookie", sessionCookie(options.sessions, session, cookie));
    return context.json({ csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() }, 201);
  });

  app.use("/api/*", async (context, next) => {
    const session = options.sessions.verify(getCookie(context, options.sessions.cookieName));
    if (session === undefined) {
      throw new HubRequestError(401, "UNAUTHORIZED", "Sign in from the terminal", "Open the Hub with `mex hub` to sign in on this browser.");
    }
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      checkWrite(context.req.raw.headers, context.get("address"), session);
    }
    context.set("session", session);
    if (context.req.path !== "/api/v1/setup" && context.req.path !== "/api/v1/knowledge/rules"
      && !(context.req.path === "/api/v1/jobs" && context.req.query("job") !== undefined)) {
      home.touch();
      agentRead.touch();
      settingsRead.touch();
      uninstallRead.touch();
    }
    await next();
  });

  app.get("/api/v1/session", (context) => {
    let session = context.get("session");
    const renewed = options.sessions.renew(session);
    if (renewed) {
      session = renewed.session;
      context.header("set-cookie", sessionCookie(options.sessions, renewed.session, renewed.cookie));
    }
    return context.json({
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      version: options.version,
      mode: options.mode,
      homePath: recordLocation({ ...location, create: false }).home,
    });
  });

  app.post("/api/v1/session/heartbeat", (context) => {
    keepOpen();
    return context.body(null, 204);
  });

  // Cookies are signed, not stored, so this browser forgets its cookie, and
  // signing out everywhere replaces the secret every cookie and link is signed with.
  const signedOut = (context: Context<{ Variables: Variables }>, cookieName: string) => {
    context.header("set-cookie", generateCookie(cookieName, "", { httpOnly: true, sameSite: "Strict", path: "/api/v1", maxAge: 0 }));
    return context.body(null, 204);
  };

  app.post("/api/v1/session/sign-out", (context) => signedOut(context, options.sessions.cookieName));

  app.post("/api/v1/session/sign-out-everywhere", (context) => {
    requireHome();
    const cookieName = options.sessions.cookieName;
    rotateHubSecret(options.sessions.home);
    options.sessions.refresh();
    return signedOut(context, cookieName);
  });

  app.get("/api/v1/projects", (context) => context.json({ projects: listProjects(location) }));

  app.get("/api/v1/home", (context) => context.json(home.get(context.req.query("tz"))));

  app.get("/api/v1/review", (context) => {
    const query = readStrictQuery(context.req.raw, ["repo", "cursor", "limit"]);
    try { return context.json(readReviewPage(home, location, query)); }
    catch (error) { throw error instanceof HubRequestError ? error : reviewUnavailable(); }
  });

  app.get("/api/v1/review/cards/:key", async (context) => {
    try { return context.json((await readReviewCard(home, location, context.req.param("key"), now(), options.env)).card); }
    catch (error) { throw error instanceof HubRequestError ? error : reviewUnavailable(); }
  });

  app.post("/api/v1/review/cards/:key/:action", async (context) => {
    const idempotency = context.req.header("Idempotency-Key");
    if (!idempotency) throw invalidReview("Provide a request key for this action.");
    const body = await readBoundedJson(context.req.raw, 64 << 10);
    return knowledgeReplays.run(context.get("session").id, idempotency, context.req.path, body, async () => {
      try { return context.json(await reviewWrites.run(context.req.param("key"), context.req.param("action"), body, context.get("session").id)); }
      catch (error) {
        return problem(context, reviewWriteProblem(error), error instanceof ReviewProblem ? error.extensions : undefined);
      }
    });
  });

  app.get("/api/v1/knowledge", (context) => context.json(readKnowledgePage(knowledge,
    readStrictQuery(context.req.raw, ["repo", "q", "kind", "audience", "status", "area", "cursor", "limit"])),
  ));

  app.get("/api/v1/knowledge/landing", (context) => {
    const { repo } = readStrictQuery(context.req.raw, ["repo"]);
    return context.json(readKnowledgeLanding(knowledge, repo));
  });

  app.get("/api/v1/knowledge/items/:key", async (context) => {
    knowledge.get();
    try { return context.json(await readKnowledgeItem(location, context.req.param("key"), now(), options.env)); }
    catch (error) { return problem(context, knowledgeReadProblem(error)); }
  });

  app.get("/api/v1/knowledge/forgotten", (context) => {
    const { repo, cursor } = readStrictQuery(context.req.raw, ["repo", "cursor"]);
    return context.json(readForgotten(knowledge, repo, cursor));
  });

  app.get("/api/v1/knowledge/rules", (context) => {
    const { repo, checkout } = readStrictQuery(context.req.raw, ["repo", "checkout"]);
    return context.json(ruleFiles.get(parseKnowledgeCheckout({ repoId: repo, checkout })));
  });

  app.post("/api/v1/knowledge/rules/refresh", (context) => machinePost(context, async (body) => {
    const rules = await ruleFiles.refresh(parseKnowledgeCheckout(body));
    events.ruleFilesChanged();
    return rules;
  }));

  app.post("/api/v1/knowledge/brief", (context) => machinePost(context, (body) => briefs.preview(body)));

  app.post("/api/v1/knowledge/notes", (context) => knowledgePost(context, (body) => knowledgeWrites.create(body), 201));
  app.post("/api/v1/knowledge/items/:key/edit", (context) => knowledgePost(context, (body) => knowledgeWrites.edit(context.req.param("key"), body)));
  app.post("/api/v1/knowledge/items/:key/forget", (context) => knowledgePost(context, (body) => knowledgeWrites.forget(context.req.param("key"), body)));

  app.get("/api/v1/agents", (context) => {
    readStrictQuery(context.req.raw, []);
    return context.json(agentRead.get());
  });

  app.get("/api/v1/agents/:agent", (context) => {
    readStrictQuery(context.req.raw, []);
    const id = readAgentId(context.req.param("agent"));
    const { agents, ...state } = agentRead.get();
    return context.json({ ...state, agent: agents?.find(agent => agent.id === id) });
  });

  app.post("/api/v1/agents/:agent/repair/preview", (context) => machinePost(context, async (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw new HubRequestError(400, "INVALID_REQUEST", "Invalid repair request", "Choose an agent to preview its repair.");
    }
    return repair.preview(readAgentId(context.req.param("agent")), context.get("session").id);
  }));

  app.post("/api/v1/agents/:agent/repair", (context) => machinePost(context, async (body) => {
    const id = readAgentId(context.req.param("agent"));
    const parsed = MachineAgentRepairRequestSchema.safeParse(body);
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid repair request", "Open and confirm a repair preview first.");
    const { revision, previewToken } = parsed.data;
    const files = [...(agentRead.get().agents?.find(agent => agent.id === id)?.files ?? [])];
    const changes = await repair.apply(id, context.get("session").id, revision, previewToken);
    for (const { path } of changes) if (!files.some(file => file.path === path) && files.length < 128) {
      files.push({ path, kind: "hookConfig", hiddenFromGit: null });
    }
    const agent = refreshedAgent(id, agentOptions, files);
    agentRead.update(current => ({ ...current, agents: current.agents?.map(row => row.id === id ? agent : row) }));
    agentRead.refresh();
    uninstallRead.refresh();
    events.controlsChanged("agents", "settings");
    return { agent };
  }));

  app.get("/api/v1/settings", (context) => {
    readStrictQuery(context.req.raw, []);
    return context.json(settingsRead.get());
  });

  app.get("/api/v1/settings/uninstall", (context) => {
    readStrictQuery(context.req.raw, []);
    return context.json(uninstallRead.get());
  });

  app.post("/api/v1/settings", (context) => machinePost(context, async (body) => {
    const parsed = MachineSettingsApplyRequestSchema.safeParse(body);
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid setting change", "Provide the setting and its current revision.");
    const { change, expectedRevision } = parsed.data;
    const env = options.env ?? process.env;
    let notice;
    if (change.type === "telemetry") notice = await applyTelemetrySetting(location, env, change.enabled, expectedRevision);
    else {
      const checkout = await applyRecordSetting(location, env, now, change, expectedRevision);
      if (checkout) {
        const followUp = setImmediate(() => {
          followUps.delete(followUp);
          if (!existsSync(hubHome)) return;
          refreshCheckoutRules(location, checkout);
          agentRead.refresh();
          uninstallRead.refresh();
        });
        followUp.unref();
        followUps.add(followUp);
      }
    }
    settingsRead.refresh();
    events.controlsChanged("settings", "home");
    return { saved: true, notice };
  }));

  app.get("/api/v1/setup", (context) => {
    const { repo } = readStrictQuery(context.req.raw, ["repo"]);
    return context.json(setup.get(repo));
  });

  app.post("/api/v1/setup/:repo/quote", (context) => machinePost(context, body =>
    setupLearning.quote(setupRepoId(context.req.param("repo")), context.get("session").id, body)));

  app.post("/api/v1/setup/:repo/learn", (context) => machinePost(context, async (body) => {
    const repoId = setupRepoId(context.req.param("repo"));
    const step = await setupLearning.start(repoId, context.get("session").id, body);
    setup.change(repoId, repo => ({ ...repo, steps: [...repo.steps, step], offerRevision: undefined, learnDeeper: undefined }));
    events.controlsChanged("setup", "jobs");
    return step;
  }));

  app.post("/api/v1/setup/:repo/skip-learning", (context) => machinePost(context, async (body) => {
    const repoId = setupRepoId(context.req.param("repo"));
    const saved = await setupLearning.skip(repoId, context.get("session").id, body);
    setup.change(repoId, repo => ({ ...repo, offerRevision: undefined, learnDeeper: { state: "skipped" } }));
    events.controlsChanged("setup");
    return saved;
  }));

  app.post("/api/v1/setup/:repo/questions", (context) => machinePost(context, async (body) => {
    const repoId = setupRepoId(context.req.param("repo"));
    const result = await answerHubSetup(location, now, options.env ?? process.env, options.agentEntry, repoId, body);
    const answered = new Set(result.questions.map(({ id }) => id));
    setup.change(repoId, repo => ({ ...repo, questions: repo.questions.filter(({ id }) => !answered.has(id)) }));
    events.controlsChanged("setup");
    if (result.questions.some(({ outcome }) => outcome?.status !== "skipped")) {
      events.controlsChanged("jobs");
      void changed(repoId, true).catch(() => { /* The next snapshot picks up the durable answer. */ });
    }
    return result;
  }));

  app.post("/api/v1/setup/:repo/steps/:id", (context) => machinePost(context, async (body) => {
    const repoId = setupRepoId(context.req.param("repo"));
    const step = await changeSetupStep(location, options.env, options.agentEntry, repoId, context.req.param("id"), body);
    setup.change(repoId, repo => ({ ...repo, steps: repo.steps.map(current => current.jobId === step.jobId ? step : current) }));
    events.controlsChanged("setup", "jobs");
    return step;
  }));

  app.get("/api/v1/jobs", (context) => {
    const { job } = readStrictQuery(context.req.raw, ["job"]);
    if (job !== undefined && !/^[A-Za-z0-9._-]{1,128}$/u.test(job)) {
      throw new HubRequestError(400, "INVALID_REQUEST", "Invalid job", "Open a job from the Hub.");
    }
    return context.json(readHubJobs(location, job));
  });

  app.post("/api/v1/jobs/:id/actions", async (context) => {
    const parsed = MachineJobActionRequestSchema.safeParse(await readBoundedJson(context.req.raw, 1_024));
    if (!parsed.success) throw new HubRequestError(400, "INVALID_REQUEST", "Invalid job action", "Choose a job action and provide its current state.");
    const result = changeHubJob(location, withWriter, options.env, context.req.param("id"), parsed.data);
    if (result.status === 404) throw new HubRequestError(404, "INVALID_REQUEST", "Job not found", "That job no longer exists.");
    if (result.status === 409) return problem(context,
      new HubRequestError(409, "JOB_CONFLICT", "The job changed", "Refresh Jobs to see its current state."), { job: result.job });
    return context.json(result.job);
  });

  app.get("/api/v1/events", (context) => {
    const cookie = getCookie(context, options.sessions.cookieName);
    return events.open(context.req.raw.signal, () => options.sessions.verify(cookie) !== undefined, context.req.method === "HEAD");
  });

  app.all("/api/*", () => {
    throw new HubRequestError(404, "INVALID_REQUEST", "Not found", "The Hub has no such resource.");
  });

  app.get("*", (context) => {
    if (options.assets === undefined) {
      throw new HubRequestError(404, "INVALID_REQUEST", "Not found", "The Hub's pages are not built.");
    }
    const path = validateHubRequestPath(context.req.raw.url);
    const requested = path === "/" ? "/index.html" : path;
    const shell = !options.assets.has(requested)
      && context.req.header("accept")?.includes("text/html") === true
      && !requested.slice(requested.lastIndexOf("/") + 1).includes(".");
    const asset = options.assets.read(shell ? "/index.html" : requested);
    return new Response(asset.bytes as BodyInit, { headers: { "content-type": asset.contentType, "cache-control": asset.cacheControl } });
  });

  return Object.assign(app, { close() {
    events.close();
    home.close();
    knowledge.close();
    briefs.close();
    ruleFiles.close();
    agentRead.close();
    settingsRead.close();
    uninstallRead.close();
    setup.close();
    for (const followUp of followUps) clearImmediate(followUp);
  } });
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "git" | "folder";
  readonly shared: boolean;
  readonly provisional: "unborn" | "shallow" | null;
  readonly checkouts: readonly { path: string; state: "on" | "off" | "off until"; offUntil: string | null; exists: boolean }[];
}

/** Every project this home knows, for the repo switcher. Read-only; empty before first use. */
export function listProjects(location: LocationOptions): ProjectSummary[] {
  const reader = openRecordReadOnly(location);
  if (!reader) return [];
  try {
    const projects = reader.all<{ id: string; root_path: string; kind: "git" | "folder"; shared: number }>("SELECT id, root_path, kind, shared FROM projects");
    const checkouts = reader.all<{ project_id: string; path: string; state: "on" | "off" | "off until"; off_until: string | null; provisional: "unborn" | "shallow" | null }>("SELECT project_id, path, state, off_until, provisional FROM checkouts ORDER BY path");
    const byProject = new Map<string, typeof checkouts>();
    for (const row of checkouts) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
    return projects.map((project) => {
      const rows = byProject.get(project.id) ?? [];
      return {
        id: project.id,
        name: basename(project.root_path) || project.root_path,
        kind: project.kind,
        shared: project.shared === 1,
        provisional: rows.find((row) => row.provisional !== null)?.provisional ?? null,
        checkouts: rows.map((row) => ({ path: row.path, state: row.state, offUntil: row.off_until, exists: existsSync(row.path) })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  } finally {
    reader.close();
  }
}

function sessionCookie(sessions: HubSessions, session: HubSession, value: string): string {
  return generateCookie(sessions.cookieName, value, { httpOnly: true, sameSite: "Strict", path: "/api/v1", maxAge: sessions.maxAgeSeconds(session) });
}

function problem(context: Context, error: unknown, extensions?: Record<string, unknown>): Response {
  const known = error instanceof HubRequestError
    || (typeof (error as { status?: unknown })?.status === "number" && typeof (error as { code?: unknown })?.code === "string");
  const status = known ? (error as { status: number }).status : 500;
  const body = {
    type: "about:blank",
    title: known ? ((error as { title?: string }).title ?? "Request failed") : "The Hub hit an error",
    status,
    code: known ? (error as { code: string }).code : "INTERNAL_ERROR",
    detail: known ? (error as Error).message : "Try again. If it keeps happening, run `mex doctor`.",
    requestId: context.get("requestId"),
    ...extensions,
  };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json; charset=UTF-8" } });
}

function applySecurityHeaders(response: Response, requestId: string): void {
  response.headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-request-id", requestId);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/")) response.headers.set("cache-control", "no-store");
}

function isPageNavigation(context: Context): boolean {
  return (context.req.method === "GET" || context.req.method === "HEAD")
    && !context.req.path.startsWith("/api/")
    && context.req.header("accept")?.includes("text/html") === true;
}

/** Plain HTML with no script or inline style, so the CSP still holds. */
function wrongAddressPage(): Response {
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="UTF-8" /><title>Open the MEX Hub from the terminal</title></head><body>',
    "<h1>Open the MEX Hub from the terminal</h1>",
    "<p>The MEX Hub only answers at <code>127.0.0.1</code> on this machine.</p>",
    "<p>Run <code>mex hub</code> and open the link it prints.</p>",
    "</body></html>",
  ].join("\n");
  return new Response(body, { status: 400, headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
}
