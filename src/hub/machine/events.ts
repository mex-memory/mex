import type { MachineChangeEvent } from "@mex/hub-contracts/machine";
import type { LocationOptions } from "../../record/location.js";
import { homeActivityFingerprint, type HomeData } from "./home.js";
import type { KnowledgeData } from "./knowledge.js";
import { jobsFingerprint } from "./jobs.js";
import { HubRequestError } from "./security.js";

const MAX_STREAMS = 8;
const POLL_MS = 2_000;
const KEEPALIVE_MS = 25_000;
const KEEP_OPEN_MS = 60_000;
// An SSE response owns its HTTP/1.1 connection until it ends. Closing the
// socket then also lets server shutdown drain without waiting for idle HTTP.
const headers = { "content-type": "text/event-stream", "cache-control": "no-store", connection: "close" };
const encoder = new TextEncoder();
const connected = encoder.encode(": connected\n\n");
const keepalive = encoder.encode(": keepalive\n\n");

type SnapshotSignal = { version: number; touch(): void };

interface Subscriber {
  authorized: () => boolean;
  send: (chunk: Uint8Array) => void;
  close: () => void;
}

export class HubEvents {
  #clients = new Set<Subscriber>();
  #poll: NodeJS.Timeout | undefined;
  #ping: NodeJS.Timeout | undefined;
  #lastKeepOpen: number | undefined;
  #jobs: string | undefined;
  #activity: string | undefined;
  #generation: number | undefined;
  #knowledge: string | undefined;
  #controlsVersion: [number, number, number, number, number] | undefined;
  #closed = false;

  constructor(
    private readonly location: LocationOptions,
    private readonly home: HomeData,
    private readonly knowledge: KnowledgeData,
    private readonly now: () => number,
    private readonly keepOpen: () => void,
    private readonly controls?: { agents: SnapshotSignal; settings: SnapshotSignal; uninstall: SnapshotSignal; setup: SnapshotSignal; ruleFiles: SnapshotSignal },
  ) {}

  open(signal: AbortSignal, authorized: () => boolean, head: boolean): Response {
    if (this.#closed || (!head && this.#clients.size >= MAX_STREAMS)) {
      throw new HubRequestError(503, "STREAM_UNAVAILABLE", "Live updates are unavailable", "Refresh the page to try again.");
    }
    if (head) return new Response(null, { headers });

    let dispose: () => void;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          dispose();
          controller.close();
        };
        const client: Subscriber = {
          authorized, close,
          send: (chunk) => {
            // A client that stopped reading must not accumulate a queue.
            if (controller.desiredSize === null || controller.desiredSize <= 0) close();
            else controller.enqueue(chunk);
          },
        };
        dispose = () => {
          signal.removeEventListener("abort", close);
          this.#clients.delete(client);
          if (!this.#clients.size) this.#stopTimers();
        };
        if (signal.aborted) {
          controller.close();
          return;
        }
        signal.addEventListener("abort", close, { once: true });
        this.#clients.add(client);
        this.home.touch();
        this.knowledge.touch();
        for (const snapshot of Object.values(this.controls ?? {})) snapshot.touch();
        if (!this.#poll) this.#startTimers();
        client.send(connected);
      },
      cancel: () => dispose?.(),
    }, { highWaterMark: 4 });
    return new Response(body, { headers });
  }

  close() {
    this.#closed = true;
    for (const client of this.#clients) client.close();
    this.#stopTimers();
  }

  #startTimers() {
    this.#lastKeepOpen ??= this.now();
    this.home.clearMetrics();
    this.#pollChanges();
    this.#poll = setInterval(() => this.#tick(), POLL_MS);
    this.#poll.unref();
    this.#ping = setInterval(() => this.#send(keepalive), KEEPALIVE_MS);
    this.#ping.unref();
  }

  #stopTimers() {
    clearInterval(this.#poll);
    clearInterval(this.#ping);
    this.#poll = this.#ping = undefined;
    this.#jobs = this.#activity = this.#generation = this.#knowledge = undefined;
    this.#controlsVersion = undefined;
  }

  #tick() {
    for (const client of this.#clients) {
      try { if (client.authorized()) continue; } catch { /* A sign-in can be read again on reconnect. */ }
      client.close();
    }
    if (!this.#clients.size) return;

    this.home.touch();
    this.knowledge.touch();
    for (const snapshot of Object.values(this.controls ?? {})) snapshot.touch();
    const now = this.now();
    if (now - this.#lastKeepOpen! >= KEEP_OPEN_MS) {
      this.#lastKeepOpen = now;
      // Lease maintenance runs on the shared timer, outside the GET handler.
      try { this.keepOpen(); } catch { /* A busy writer can be retried at the next heartbeat. */ }
    }
    this.#pollChanges();
  }

  #pollChanges() {
    const topics: MachineChangeEvent["topics"] = [];
    try {
      const jobs = jobsFingerprint(this.location);
      if (this.#jobs !== undefined && jobs !== this.#jobs) topics.push("jobs");
      this.#jobs = jobs;
    } catch { /* Keep the previous baseline while the record is busy. */ }
    const snapshotChanged = this.#generation !== undefined && this.#generation !== this.home.generation;
    let homeChanged = snapshotChanged;
    this.#generation = this.home.generation;
    try {
      const activity = homeActivityFingerprint(this.location);
      if (this.#activity !== undefined && this.#activity !== activity) {
        this.home.clearMetrics();
        homeChanged = true;
      }
      this.#activity = activity;
    } catch { /* Try again on the next tick. */ }
    if (homeChanged) topics.push("home");
    if (snapshotChanged) topics.push("review");
    const knowledge = this.knowledge.eventVersion;
    if (this.#knowledge !== undefined && this.#knowledge !== knowledge) topics.push("knowledge");
    this.#knowledge = knowledge;
    if (this.controls) {
      const { agents, settings, uninstall, setup, ruleFiles } = this.controls;
      const previous = this.#controlsVersion;
      if (previous && previous[0] !== agents.version) topics.push("agents");
      if (previous && (previous[1] !== settings.version || previous[2] !== uninstall.version)) topics.push("settings");
      if (previous && previous[3] !== setup.version) topics.push("setup");
      if (previous && previous[4] !== ruleFiles.version && !topics.includes("knowledge")) topics.push("knowledge");
      this.#controlsVersion = [agents.version, settings.version, uninstall.version, setup.version, ruleFiles.version];
    }
    this.#sendChange(topics);
  }

  reviewChanged(notesChanged: boolean) {
    if (!this.#clients.size) return;
    this.#generation = this.home.generation;
    const topics: MachineChangeEvent["topics"] = ["review", "home"];
    if (notesChanged) {
      this.#knowledge = this.knowledge.eventVersion;
      topics.push("knowledge");
    }
    this.#sendChange(topics);
  }

  controlsChanged(...topics: MachineChangeEvent["topics"]) {
    this.#sendChange(topics);
  }

  #sendChange(topics: MachineChangeEvent["topics"]) {
    if (topics.length) this.#send(encoder.encode(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`));
  }

  #send(chunk: Uint8Array) {
    for (const client of this.#clients) client.send(chunk);
  }
}
