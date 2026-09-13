import { lstatSync } from "node:fs";
import {
  SetupContactRequestSchema, submitContactPayload, WEB3FORMS_ACCESS_KEY,
  type ContactPreference, type ContactPreferenceRequest, type SetupContactRequest, type SetupContactResponse,
} from "@mex/hub-contracts/setup";
import { mexHomeDir, ensureMexHomeDir } from "../global-config.js";
import { atomicCreateArtifact, tryReadContainedArtifact, withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { VERSION } from "../version.js";

const MARKER = '{"schemaVersion":1}\n';

/** No contact details or analytics identifiers are retained on disk. */
export function readContactPreference(): ContactPreference {
  try {
    const root = mexHomeDir();
    try {
      const stat = lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "unavailable" };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unasked" : "unavailable" };
    }
    for (const status of ["submitted", "skipped"] as const) {
      const marker = tryReadContainedArtifact(root, `setup/contact-${status}.json`, 64);
      if (marker) return { status: new TextDecoder().decode(marker.bytes) === MARKER ? status : "unavailable" };
    }
    return { status: "unasked" };
  } catch { return { status: "unavailable" }; }
}

export async function rememberContactPreference(request: ContactPreferenceRequest): Promise<ContactPreference> {
  ensureMexHomeDir();
  return withContainedArtifactLock(mexHomeDir(), "setup", ".contact.lock", () => {
    const before = readContactPreference();
    if (before.status === "unavailable") throw new Error("The saved contact preference could not be read.");
    if (before.status === "submitted" || before.status === request.status) return before;
    atomicCreateArtifact(mexHomeDir(), `setup/contact-${request.status}.json`, MARKER, 0o600);
    return readContactPreference();
  });
}

/** Only an explicit Submit action calls this separate, non-telemetry transport. */
export async function submitSetupContact(
  input: SetupContactRequest,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SetupContactResponse> {
  const request = SetupContactRequestSchema.parse(input);
  if (readContactPreference().status === "submitted") {
    return { ok: true, status: "submitted", message: "Thanks — your details have already been sent." };
  }
  ensureMexHomeDir();
  return withContainedArtifactLock(mexHomeDir(), "setup", ".contact-send.lock", async () => {
    if (readContactPreference().status === "submitted") return { ok: true, status: "submitted", message: "Thanks — your details have already been sent." };
    const result = await submitContactPayload({
      access_key: WEB3FORMS_ACCESS_KEY, email: request.email,
      ...(request.name ? { name: request.name } : {}),
      subject: "mex setup feedback contact", from_name: "mex", source: "mex-setup",
      mex_version: VERSION, contact_permission: "Follow up about my experience with MEX",
    }, options.fetch, options.signal);
    if (!result.ok) return { ok: false, status: readContactPreference().status, message: result.message };
    try { await rememberContactPreference({ status: "submitted" }); }
    catch { return { ok: true, status: "submitted", message: "Thanks — your details were sent. This device could not save the preference, so you may see this invitation again." }; }
    return { ok: true, status: "submitted", message: "Thanks — we’ll be in touch about your experience with MEX." };
  });
}
