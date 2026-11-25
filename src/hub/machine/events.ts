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
  #closed = false;

  constructor(
    private readonly location: LocationOptions,
    private readonly home: HomeData,
    private readonly knowledge: KnowledgeData,
    private readonly now: () => number,
    private readonly keepOpen: () => void,
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
  }

  #tick() {
    for (const client of this.#clients) {
      try { if (client.authorized()) continue; } catch { /* A sign-in can be read again on reconnect. */ }
      client.close();
    }
    if (!this.#clients.size) return;

    this.home.touch();
    this.knowledge.touch();
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
    let homeChanged = this.#generation !== undefined && this.#generation !== this.home.generation;
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
    const knowledge = this.knowledge.eventVersion;
    if (this.#knowledge !== undefined && this.#knowledge !== knowledge) topics.push("knowledge");
    this.#knowledge = knowledge;
    this.#sendChange(topics);
  }

  knowledgeChanged() {
    if (!this.#clients.size) return;
    this.#knowledge = this.knowledge.eventVersion;
    this.#sendChange(["knowledge"]);
  }

  #sendChange(topics: MachineChangeEvent["topics"]) {
    if (topics.length) this.#send(encoder.encode(`event: change\ndata: ${JSON.stringify({ topics })}\n\n`));
  }

  #send(chunk: Uint8Array) {
    for (const client of this.#clients) client.send(chunk);
  }
}
