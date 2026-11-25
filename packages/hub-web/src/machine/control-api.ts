import {
  MachineAgentRepairPreviewSchema, MachineAgentRepairRequestSchema, MachineAgentRepairResultSchema, MachineAgentsSnapshotSchema,
  MachineAgentSnapshotSchema, MachineSettingsApplyRequestSchema, MachineSettingsApplyResultSchema, MachineSettingsSnapshotSchema,
  MachineUninstallSnapshotSchema,
} from "@mex/hub-contracts/machine";
import type { z } from "zod";
import { requestJson } from "./api";
import type { BrowserAgentRepair, MachineAgent } from "./types";

type Credentials = { csrfToken: string; idempotencyKey: string };
export type SettingsChange = z.infer<typeof MachineSettingsApplyRequestSchema>["change"];

function post({ csrfToken, idempotencyKey }: Credentials, body: unknown) {
  return {
    method: "POST", headers: { "content-type": "application/json", "x-mex-csrf": csrfToken, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body), timeoutMs: 12_000,
  };
}

const agentPath = (agent: string) => "/agents/" + encodeURIComponent(agent);

export function getAgents(signal: AbortSignal) {
  return requestJson("/agents", MachineAgentsSnapshotSchema, { signal });
}

export function getAgent(agent: string, signal: AbortSignal) {
  return requestJson(agentPath(agent), MachineAgentSnapshotSchema, { signal });
}

export function previewAgentRepair(agent: MachineAgent["id"], credentials: Credentials) {
  return requestJson(agentPath(agent) + "/repair/preview", MachineAgentRepairPreviewSchema, post(credentials, {}));
}

export function repairAgent(preview: BrowserAgentRepair, credentials: Credentials) {
  const request = MachineAgentRepairRequestSchema.parse({ revision: preview.revision, previewToken: preview.previewToken });
  return requestJson(agentPath(preview.agentId) + "/repair", MachineAgentRepairResultSchema, post(credentials, request));
}

export function getSettings(signal: AbortSignal) {
  return requestJson("/settings", MachineSettingsSnapshotSchema, { signal });
}

export function getUninstallPreview(signal: AbortSignal) {
  return requestJson("/settings/uninstall", MachineUninstallSnapshotSchema, { signal });
}

export function changeSetting(change: SettingsChange, expectedRevision: string, credentials: Credentials) {
  const request = MachineSettingsApplyRequestSchema.parse({ change, expectedRevision });
  return requestJson("/settings", MachineSettingsApplyResultSchema, post(credentials, request));
}
