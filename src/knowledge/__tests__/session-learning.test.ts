import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecord, type RecordWriter } from "../../record/index.js";
import "../../record/job-kinds.js";
import { enqueueJob, jobKind } from "../../record/jobs.js";
import { dueOffer, registerOffer, type Offer } from "../../repo-start/offers.js";
import { listProducers } from "../producers.js";
import {
  SESSION_LEARN_KIND, SESSION_LEARNING_UNAVAILABLE, sessionLearningAvailable, sessionLearningOn, sessionLearningRefusal, setSessionLearning,
} from "../session-learning.js";

let home: string, writer: RecordWriter;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mex-session-learning-"));
  writer = openRecord({ home: join(home, "record"), isNetwork: () => false });
  writer.db.prepare("INSERT INTO projects(id,root_path,kind,created_at) VALUES('f-session000000000000000000',?,'folder','2026-01-01')").run(home);
});
afterEach(() => writer.close());

describe("reserved session-learning slots", () => {
  it("has no active producer, so nothing about it opens", () => {
    expect(listProducers().filter(p => p.id.startsWith("session-")).map(p => [p.id, p.active])).toEqual([["session-import", false], ["session-ongoing", false]]);
    expect(sessionLearningAvailable()).toBe(false);
  });

  it("registers the job kind but refuses to queue it, writing no row", () => {
    expect(jobKind(SESSION_LEARN_KIND)?.reserved).toBeTruthy();
    expect(() => enqueueJob(writer, { kind: SESSION_LEARN_KIND, projectId: "f-session000000000000000000" }))
      .toThrow("Learning from past sessions isn't available in this version yet; nothing was queued.");
    expect(writer.db.prepare("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("refuses learning.sessions on, accepts off, and defaults to off", () => {
    expect(sessionLearningOn(writer)).toBe(false);
    expect(sessionLearningRefusal("on")).toBe(SESSION_LEARNING_UNAVAILABLE);
    expect(() => setSessionLearning(writer, "on")).toThrow(SESSION_LEARNING_UNAVAILABLE);
    expect(writer.setting("global", "learning.sessions")).toBeUndefined();
    expect(sessionLearningRefusal("maybe")).toBe("Use on or off for learning.sessions.");
    setSessionLearning(writer, "off");
    expect(writer.setting("global", "learning.sessions")).toBe("off");
    expect(sessionLearningOn(writer)).toBe(false);
  });

  it("keeps the offer slot hidden until a real offer takes its place", async () => {
    const context = { projectId: "f-session000000000000000000", root: home };
    expect(dueOffer(context)?.id).not.toBe("session-learn");
    const real: Offer = { id: "session-learn", question: "Learn from your past sessions?", estimate: "about $0.20", command: "mex learn --sessions", paid: true,
      due: () => true, start: async () => "started" };
    registerOffer(real);
    expect(dueOffer(context)).toBe(real);
  });
});
