import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { enqueueJob, registerJobKind, type JobKind } from "../record/jobs.js";
import { ForgeClient, hostToken, object, SourceError } from "./forge.js";
import { evidenceDigest } from "./harvest/index.js";
import { NETWORK_KIND, networkProofPrefix, networkRowKey, readNetworkGroups, type NetworkGroup } from "./network-proof.js";
import { sessionsActive, WeeklySchedule } from "./weekly-schedule.js";

const PAGE = 4;
const IDLE = "Waiting for agent sessions to finish";
const query = `query LearnedEvidence($ids: [ID!]!) {
  nodes(ids: $ids) { id
    ... on PullRequest { body }
    ... on PullRequestReview { body }
    ... on PullRequestReviewComment { body }
    ... on IssueComment { body }
    ... on Issue { body }
  }
}`;

type State = "same" | "edited" | "deleted";
type Client = Pick<ForgeClient, "graphql">;
interface Observation { key: string; state: State; }

export async function networkObservations(client: Client, groups: NetworkGroup[]): Promise<Observation[]> {
  groups = groups.filter(group => group.complete && group.nodes.length > 0);
  const ids = [...new Set(groups.flatMap(group => group.nodes))];
  const bodies = new Map<string, string | null>();
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    let nodes: unknown;
    try { nodes = (await client.graphql(query, { ids: chunk })).nodes; }
    catch (error) {
      if (!(error instanceof SourceError)) throw error;
      // GraphQL errors can include path-specific permission failures. With
      // an errored reply, null does not establish deletion.
      if (error.problem !== "unavailable") break;
      continue;
    }
    if (!Array.isArray(nodes) || nodes.length !== chunk.length) continue;
    for (const [i, id] of chunk.entries()) {
      const value = nodes[i], row = object(value);
      if (value === null) bodies.set(id, null);
      else if (row?.id === id && typeof row.body === "string") bodies.set(id, row.body);
    }
  }
  return groups.flatMap(group => {
    const ordered = group.nodes.map(id => bodies.get(id));
    if (ordered.some(body => body === undefined)) return [];
    const state: State = ordered.includes(null) ? "deleted" : evidenceDigest(ordered as string[]) === group.hash ? "same" : "edited";
    return [{ key: networkRowKey(group.url, group.hash), state }];
  });
}

type Checkpoint = { after: string; gaps: boolean; judge?: boolean };

export function networkKind(now = Date.now, connect = async (schedule: WeeklySchedule) =>
  new ForgeClient(schedule.origin, await hostToken(schedule.checkout, schedule.origin))): JobKind<WeeklySchedule, Checkpoint> {
  return {
    name: NETWORK_KIND, label: "Check learned sources", scope: "project", sideEffects: "idempotent",
    async runBatch({ writer, params, job, checkpoint = { after: "", gaps: false } }) {
      const schedule = WeeklySchedule.parse(params), project = job.project_id!;
      const allowed = () => {
        const checkout = writer.checkout(schedule.checkout);
        return checkout?.project_id === project && checkoutOn(checkout, now()) && automaticWorkEnabled(writer, project, now());
      };
      if (!allowed()) return { checkpoint, done: true, gaps: true, summary: "Automatic work is off here." };
      if (sessionsActive(writer, now())) return { checkpoint, wait: IDLE };
      const queueJudge = () => enqueueJob(writer, { kind: "judge", projectId: project, params: { checkout: schedule.checkout, agent: schedule.agent, near: [] } });
      const rows = writer.db.prepare(`SELECT key,CASE WHEN length(CAST(value AS BLOB))<=524288 THEN value END value FROM settings
        WHERE scope=? AND key GLOB ? AND key>? ORDER BY key LIMIT ?`).all(project, `${networkProofPrefix}*`, checkpoint.after, PAGE);
      if (!rows.length) {
        if (checkpoint.judge) queueJudge();
        return { checkpoint, done: true, gaps: checkpoint.gaps };
      }
      const groups = rows.flatMap(row => typeof row.value === "string" ? readNetworkGroups(row.value) : []);
      const repos = new Map([schedule.origin, schedule.source].filter(repo => repo.host === "github.com").map(repo => [repo.slug.toLowerCase(), repo.slug]));
      const client = groups.length ? await connect(schedule) : undefined;
      if (client?.anonymous) return { checkpoint, done: true, gaps: true, summary: "Sign in to check learned sources." };
      const access = new Map<string, boolean>();
      const readable: NetworkGroup[] = [];
      for (const group of groups) {
        const slug = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/\d+(?:#.*)?$/u.exec(group.url)?.[1];
        const repo = slug && repos.get(slug.toLowerCase());
        if (!client || !repo) continue;
        if (!access.has(repo)) {
          try { access.set(repo, !!await client.get(`/repos/${repo}`, true)); }
          catch (error) { if (!(error instanceof SourceError)) throw error; access.set(repo, false); }
        }
        if (access.get(repo)) readable.push(group);
      }
      const observed = client ? await networkObservations(client, readable) : [];
      let judge = checkpoint.judge ?? false;
      writer.db.exec("BEGIN IMMEDIATE");
      try {
        const live = writer.db.prepare("SELECT state,owner,request FROM jobs WHERE id=?").get(job.id);
        if (!allowed() || live?.state !== "running" || live.owner !== job.owner || live.request !== null) {
          writer.db.exec("COMMIT");
          return { checkpoint, wait: "Waiting to save learned source checks" };
        }
        const set = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
        const at = new Date(now()).toISOString();
        for (const { key, state } of observed) {
          if (state !== "same") judge = true;
          set.run(project, key, JSON.stringify({ state, at }));
        }
        writer.db.exec("COMMIT");
      } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
      const done = rows.length < PAGE;
      if (done && judge) queueJudge();
      const gaps = checkpoint.gaps || observed.length !== groups.length;
      return { checkpoint: { after: String(rows.at(-1)!.key), gaps, judge }, results: observed.length, done, gaps,
        summary: `${observed.length} learned source checks observed.` };
    },
    ready(job, writer) { return job.reason !== IDLE || !sessionsActive(writer, now()); },
  };
}

registerJobKind(networkKind());
