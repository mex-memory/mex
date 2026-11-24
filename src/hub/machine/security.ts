import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hubSecretVersion, loadHubSecret, type HubSecret } from "./secret.js";

/**
 * Browser security for the machine Hub. The posture is the 0.8 Hub's (loopback only, Host
 * check, Origin plus CSRF header on every write, token in the URL fragment), with sessions
 * derived from a per-home secret so bookmarks survive a restart.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** A session with less than this left is renewed when the page reads it. */
export const SESSION_RENEW_MS = 15 * 24 * 60 * 60 * 1_000;
export const BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;
export const CSRF_HEADER = "x-mex-csrf";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-real-ip"] as const;

export type HubProblem = "INVALID_REQUEST" | "UNAUTHORIZED" | "ORIGIN_REJECTED";

export class HubRequestError extends Error {
  constructor(readonly status: number, readonly code: HubProblem, readonly title: string, detail: string) {
    super(detail);
    this.name = "HubRequestError";
  }
}

export interface HubSession {
  readonly id: string;
  readonly expiresAt: number;
  readonly csrfToken: string;
}

export interface RequestAddress {
  /** The Host header, exactly as sent. */
  readonly host: string;
  /** The origin this request's page must have: `http://<host>`, or https behind Codespaces. */
  readonly origin: string;
}

export interface HostPolicyOptions {
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Accept loopback names on any port (an SSH or VS Code forward may remap the port) and,
 * only inside a Codespace, its forwarding domain. Everything else is a DNS-rebinding risk.
 */
export function checkHost(headers: Headers, options: HostPolicyOptions = {}): RequestAddress {
  const host = headers.get("host") ?? "";
  const parsed = parseHost(host);
  if (!parsed) throw wrongAddress("The request has no valid Host.");
  const codespace = codespaceHost(parsed.hostname, options.env ?? process.env);
  if (!codespace) {
    for (const name of FORWARDED_HEADERS) {
      if (headers.has(name)) {
        throw new HubRequestError(400, "INVALID_REQUEST", "Proxy headers rejected", "The Hub answers only direct requests from this machine.");
      }
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) throw wrongAddress("The Hub answers only at 127.0.0.1.");
  }
  return { host, origin: `${codespace ? "https" : "http"}://${host}` };
}

/** Writes must come from a page this Hub served: same Origin, same-origin fetch, and the CSRF header. */
export function checkWrite(headers: Headers, address: RequestAddress, session: HubSession | undefined): void {
  if (headers.get("origin") !== address.origin) {
    throw new HubRequestError(403, "ORIGIN_REJECTED", "Origin rejected", "Changes must come from a Hub page on this machine.");
  }
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    throw new HubRequestError(403, "ORIGIN_REJECTED", "Origin rejected", "Changes must come from a Hub page on this machine.");
  }
  if (session === undefined) return;
  const supplied = headers.get(CSRF_HEADER);
  if (supplied === null || !equalText(supplied, session.csrfToken)) {
    throw new HubRequestError(403, "ORIGIN_REJECTED", "Reload the Hub", "This page is out of date. Reload it and try again.");
  }
}

/** Sessions signed with the per-home secret. Re-reads the secret when its file changes. */
export class HubSessions {
  #secret: HubSecret;

  constructor(readonly home: string, private readonly now: () => number = Date.now) {
    this.#secret = loadHubSecret(home);
  }

  /** The cookie name is derived from the secret, so two MEX homes on one machine never share it. */
  get cookieName(): string {
    this.refresh();
    return `mex_hub_${this.#mac("n1").subarray(0, 12).toString("base64url")}`;
  }

  create(): { session: HubSession; cookie: string } {
    this.refresh();
    const id = randomBytes(16).toString("base64url");
    const expiresAt = Math.floor((this.now() + SESSION_TTL_MS) / 1_000) * 1_000;
    return { session: this.#session(id, expiresAt), cookie: this.#cookie(id, expiresAt) };
  }

  /** Verify a cookie value. Undefined means sign in again; it never says why, to anyone. */
  verify(value: string | undefined): HubSession | undefined {
    this.refresh();
    if (value === undefined) return undefined;
    const parts = value.split(".");
    if (parts.length !== 3) return undefined;
    const [id, expiry, mac] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^[0-9]{1,15}$/.test(expiry)) return undefined;
    const expiresAt = Number(expiry) * 1_000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return undefined;
    if (!equalText(mac, this.#mac(`s1|${id}|${expiry}`).toString("base64url"))) return undefined;
    return this.#session(id, expiresAt);
  }

  /** A fresh cookie for a session close to expiry, otherwise undefined. */
  renew(session: HubSession): { session: HubSession; cookie: string } | undefined {
    this.refresh();
    if (session.expiresAt - this.now() >= SESSION_RENEW_MS) return undefined;
    const expiresAt = Math.floor((this.now() + SESSION_TTL_MS) / 1_000) * 1_000;
    return { session: this.#session(session.id, expiresAt), cookie: this.#cookie(session.id, expiresAt) };
  }

  maxAgeSeconds(session: HubSession): number {
    return Math.max(1, Math.floor((session.expiresAt - this.now()) / 1_000));
  }

  /** Pick up a replaced secret file (sign out everywhere) without a restart. */
  refresh(): void {
    const version = hubSecretVersion(this.home);
    if (version !== undefined && version !== this.#secret.version) this.#secret = loadHubSecret(this.home);
  }

  #session(id: string, expiresAt: number): HubSession {
    return { id, expiresAt, csrfToken: this.#mac(`c1|${id}`).toString("base64url") };
  }

  #cookie(id: string, expiresAt: number): string {
    const expiry = String(expiresAt / 1_000);
    return `${id}.${expiry}.${this.#mac(`s1|${id}|${expiry}`).toString("base64url")}`;
  }

  #mac(message: string): Buffer {
    return createHmac("sha256", this.#secret.bytes).update(message).digest();
  }
}

/** A one-time sign-in token for the printed link. */
export function newBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The key the record keeps for a sign-in link: keyed by the Hub secret, so replacing the
 * secret (sign out everywhere) also voids every link not used yet.
 */
export function bootstrapKey(secret: Buffer, token: string): string {
  return createHmac("sha256", secret).update(`b1|${token}`).digest("hex");
}

export function isBootstrapToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function parseHost(host: string): { hostname: string; port: string } | undefined {
  if (host.length === 0 || host.length > 255) return undefined;
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match) return undefined;
  const port = match[2] ?? "";
  if (port !== "" && (Number(port) < 1 || Number(port) > 65_535)) return undefined;
  return { hostname: match[1]!.toLowerCase(), port };
}

function codespaceHost(hostname: string, env: NodeJS.ProcessEnv): boolean {
  if (env.CODESPACES !== "true") return false;
  const domain = (env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev").toLowerCase();
  return hostname.endsWith(`.${domain}`) && hostname.length > domain.length + 1;
}

function wrongAddress(detail: string): HubRequestError {
  return new HubRequestError(400, "INVALID_REQUEST", "Wrong address", detail);
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
