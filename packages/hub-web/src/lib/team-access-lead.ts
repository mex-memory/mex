/**
 * Checkout-local team-access lead capture. The Hub posts only the fields below
 * to Web3Forms from the browser; it never attaches repo, path, graph, or machine data.
 *
 * Configure the public access key here, or override at Hub build time with
 * VITE_WEB3FORMS_ACCESS_KEY. Web3Forms access keys are designed to ship in
 * frontend bundles; do not put SMTP passwords or other private secrets here.
 */
import { WEB3FORMS_ACCESS_KEY, WEB3FORMS_SUBMIT_URL, submitContactPayload } from "@mex/hub-contracts/setup";
export { WEB3FORMS_ACCESS_KEY, WEB3FORMS_SUBMIT_URL };
export {
  TEAM_ACCESS_STORAGE_KEY,
  readTeamAccessState,
  writeTeamAccessState,
  type TeamAccessLocalState,
} from "./team-access-state";
export const TEAM_ACCESS_SUBJECT = "mex Hub team access";
export const TEAM_ACCESS_FOLLOW_UP_SUBJECT = "mex Hub team access follow-up";
export const TEAM_ACCESS_FROM_NAME = "mex Hub";
export const TEAM_ACCESS_SOURCE = "mex-hub";
export const TEAM_ACCESS_SUBMIT_ERROR = "Could not send your request. Try again.";

export const TEAM_ACCESS_TEAM_SIZES = ["Just me", "2–10", "11–50", "50+"] as const;
export const TEAM_ACCESS_FOUND_MEX = ["GitHub", "X", "friend", "community", "search", "other"] as const;
export const TEAM_ACCESS_INSTALL_REASONS = ["Agent memory", "team consistency", "token cost", "curiosity"] as const;
export const TEAM_ACCESS_REPO_KINDS = ["Work", "personal"] as const;
export const TEAM_ACCESS_OTHERS_USE_AGENTS = ["Yes", "No"] as const;
export const TEAM_ACCESS_NEEDS = ["Local only is fine", "Shared team memory", "Not sure"] as const;

export interface TeamAccessContact {
  name: string;
  email: string;
}

export interface TeamAccessFollowUp extends TeamAccessContact {
  company: string;
  teamSize: string;
  foundMex: string;
  installReason: string;
  repoKind: string;
  othersUseAgents: string;
  need: string;
  missing: string;
}

const NAME_MAX = 200;
const EMAIL_MAX = 320;
const COMPANY_MAX = 200;
const MISSING_MAX = 240;

let accessKeyOverride: string | null = null;

/** Test seam: inject a public access key without touching import.meta.env. */
export function __setWeb3FormsAccessKeyForTests(value: string | null): void {
  accessKeyOverride = value;
}

export function getWeb3FormsAccessKey(): string {
  if (accessKeyOverride !== null) return accessKeyOverride;
  const fromEnv = import.meta.env.VITE_WEB3FORMS_ACCESS_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return WEB3FORMS_ACCESS_KEY.trim();
}

export function boundName(value: string): string {
  return value.trim().slice(0, NAME_MAX);
}

export function boundEmail(value: string): string {
  return value.trim().slice(0, EMAIL_MAX);
}

export function boundCompany(value: string): string {
  return value.trim().slice(0, COMPANY_MAX);
}

export function boundMissing(value: string): string {
  return value.trim().slice(0, MISSING_MAX);
}

function includeAllowed(
  payload: Record<string, string>,
  key: string,
  value: string,
  allowed: readonly string[],
): void {
  if (allowed.includes(value)) payload[key] = value;
}

export function validateTeamAccessContact(name: string, email: string): {
  name?: string;
  email?: string;
} {
  const errors: { name?: string; email?: string } = {};
  if (boundName(name) === "") errors.name = "Enter your name.";
  const trimmedEmail = boundEmail(email);
  if (trimmedEmail === "") errors.email = "Enter your email.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) errors.email = "Enter a valid email.";
  return errors;
}

export function buildTeamAccessContactPayload(contact: TeamAccessContact, accessKey = getWeb3FormsAccessKey()) {
  return {
    access_key: accessKey,
    name: boundName(contact.name),
    email: boundEmail(contact.email),
    subject: TEAM_ACCESS_SUBJECT,
    from_name: TEAM_ACCESS_FROM_NAME,
    source: TEAM_ACCESS_SOURCE,
  };
}

export function buildTeamAccessFollowUpPayload(details: TeamAccessFollowUp, accessKey = getWeb3FormsAccessKey()) {
  const payload: Record<string, string> = {
    access_key: accessKey,
    name: boundName(details.name),
    email: boundEmail(details.email),
    subject: TEAM_ACCESS_FOLLOW_UP_SUBJECT,
    from_name: TEAM_ACCESS_FROM_NAME,
    source: TEAM_ACCESS_SOURCE,
  };
  const company = boundCompany(details.company);
  if (company !== "") payload.company = company;
  includeAllowed(payload, "team_size", details.teamSize, TEAM_ACCESS_TEAM_SIZES);
  includeAllowed(payload, "found_mex", details.foundMex, TEAM_ACCESS_FOUND_MEX);
  includeAllowed(payload, "install_reason", details.installReason, TEAM_ACCESS_INSTALL_REASONS);
  includeAllowed(payload, "repo_kind", details.repoKind, TEAM_ACCESS_REPO_KINDS);
  includeAllowed(payload, "others_use_agents", details.othersUseAgents, TEAM_ACCESS_OTHERS_USE_AGENTS);
  includeAllowed(payload, "i_need", details.need, TEAM_ACCESS_NEEDS);
  const missing = boundMissing(details.missing);
  if (missing !== "") payload.whats_missing = missing;
  return payload;
}

export async function submitTeamAccessPayload(
  payload: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await submitContactPayload(payload, fetchImpl);
  return result.ok ? result : { ok: false, message: TEAM_ACCESS_SUBMIT_ERROR };
}
