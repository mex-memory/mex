import { describe, expect, it } from "vitest";
import {
  TELEMETRY_AI_TOOLS,
  eventAttributes,
  makeEvent,
  previewEvent,
  validateStoredEvent,
  type TelemetryAttributes,
  type TelemetryEventName,
} from "../src/telemetry/schema.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const SCAFFOLD_ID = "22222222-2222-4222-8222-222222222222";
const CASES: Array<[TelemetryEventName, TelemetryAttributes]> = [
  ["cli.command_started", { command: "wiki.query", stage: "direct" }],
  ["cli.command_completed", { command: "wiki.query", outcome: "success", duration_ms: 12 }],
  ["hub.session_started", {}],
  ["hub.page_viewed", { page: "knowledge" }],
  ["hub.action_completed", { action: "relay.publish", stage: "apply", outcome: "success", duration_ms: 12 }],
  ["hub.job_completed", { job_kind: "graph_refresh", outcome: "success", duration_ms: 12 }],
];

describe("optional project context in the telemetry catalog", () => {
  it.each(CASES)("round-trips approved context on %s", (name, attributes) => {
    const event = makeEvent(name, {
      ...attributes,
      scaffold_id: SCAFFOLD_ID,
      configured_ai_tools: ["claude", "codex"],
    }, INSTALLATION_ID);

    expect(event).toBeDefined();
    expect(event!.properties).toEqual({
      ...makeEvent(name, attributes, INSTALLATION_ID)!.properties,
      scaffold_id: SCAFFOLD_ID,
      configured_ai_tools: ["claude", "codex"],
    });
    expect(event!.distinct_id).toBe(INSTALLATION_ID);
    expect(event!.properties.schema_version).toBe(2);
    expect(event!.properties.$process_person_profile).toBe(false);
    expect(event!.properties.$geoip_disable).toBe(true);
    expect(validateStoredEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
  });

  it.each(CASES)("preserves previously queued v2 events without project fields: %s", (name, attributes) => {
    const event = makeEvent(name, attributes, INSTALLATION_ID)!;
    expect(event.properties).not.toHaveProperty("scaffold_id");
    expect(event.properties).not.toHaveProperty("configured_ai_tools");
    expect(validateStoredEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
  });

  it("allows either optional field independently and preserves an explicit empty selection", () => {
    expect(eventAttributes("hub.session_started", { scaffold_id: SCAFFOLD_ID })).toEqual({ scaffold_id: SCAFFOLD_ID });
    expect(eventAttributes("hub.team_access", { step: "dialog_opened" })).toEqual({ step: "dialog_opened" });
    expect(eventAttributes("hub.team_access", { step: "email_typed" })).toBeUndefined();
    expect(eventAttributes("hub.team_access", {})).toBeUndefined();
    expect(eventAttributes("hub.team_access", { step: "submitted", email: "ada@example.com" })).toBeUndefined();
    expect(eventAttributes("hub.page_viewed", { page: "home", step: "submitted" })).toBeUndefined();
    expect(eventAttributes("hub.session_started", { configured_ai_tools: [] })).toEqual({ configured_ai_tools: [] });
    expect(eventAttributes("hub.session_started", { configured_ai_tools: [...TELEMETRY_AI_TOOLS] }))
      .toEqual({ configured_ai_tools: [...TELEMETRY_AI_TOOLS] });
  });

  it("copies tool selections at capture and preview so later caller mutations cannot change an event", () => {
    const tools = ["claude", "codex"];
    const attributes = { command: "wiki.query", configured_ai_tools: tools };
    const projected = eventAttributes("cli.command_started", attributes)!;
    const event = makeEvent("cli.command_started", attributes, INSTALLATION_ID)!;
    const preview = previewEvent("cli.command_started", projected, INSTALLATION_ID);
    tools.push("sensitive-freeform-value");
    projected.configured_ai_tools!.push("cursor");

    expect(event.properties.configured_ai_tools).toEqual(["claude", "codex"]);
    expect(preview.properties).toHaveProperty("configured_ai_tools", ["claude", "codex"]);
    expect(validateStoredEvent(event)).toBe(true);
  });

  it.each([
    null, 42, [], {}, "private-project-name", "11111111111141118111111111111111",
    "22222222-2222-1222-8222-222222222222", "22222222-2222-4222-7222-222222222222",
    "22222222-2222-4222-8222-222222222222/private/path",
    "22222222-2222-4222-8222-222222222222\n",
  ].map((scaffold_id) => ({ scaffold_id })))("rejects invalid scaffold identity $scaffold_id at capture and persisted boundaries", ({ scaffold_id }) => {
    expect(makeEvent("hub.session_started", { scaffold_id }, INSTALLATION_ID)).toBeUndefined();
    const event = makeEvent("hub.session_started", {}, INSTALLATION_ID)!;
    expect(validateStoredEvent({ ...event, properties: { ...event.properties, scaffold_id } })).toBe(false);
  });

  it.each([
    null, "codex", { tool: "codex" }, [null], [42], [[]], [{ name: "codex" }],
    ["Claude"], ["claude-code"], ["/private/tool/path"], ["codex", "unknown"],
    ["codex", "claude"], ["claude", "claude"], ["codex", "codex"],
    [...TELEMETRY_AI_TOOLS, "windsurf"], new Array(2),
  ].map((configured_ai_tools) => ({ configured_ai_tools })))("rejects malformed, unsorted, duplicate, or unbounded selections $configured_ai_tools", ({ configured_ai_tools }) => {
    expect(makeEvent("hub.session_started", { configured_ai_tools }, INSTALLATION_ID)).toBeUndefined();
    const event = makeEvent("hub.session_started", {}, INSTALLATION_ID)!;
    expect(validateStoredEvent({ ...event, properties: { ...event.properties, configured_ai_tools } })).toBe(false);
  });

  it.each(["scaffold_name", "project_path", "origin", "upstream", "ai_tool", "prompt", "email"])(
    "continues rejecting unapproved field %s even with approved context", (key) => {
      const attributes = { scaffold_id: SCAFFOLD_ID, configured_ai_tools: ["codex"], [key]: "private-value" };
      expect(makeEvent("hub.session_started", attributes, INSTALLATION_ID)).toBeUndefined();
      const event = makeEvent("hub.session_started", {}, INSTALLATION_ID)!;
      expect(validateStoredEvent({ ...event, properties: { ...event.properties, ...attributes } })).toBe(false);
    },
  );

  it("does not let optional context bypass the event-specific property allowlist", () => {
    const attributes = { scaffold_id: SCAFFOLD_ID, configured_ai_tools: ["codex"], command: "wiki.query" };
    expect(eventAttributes("hub.session_started", attributes)).toBeUndefined();
    expect(eventAttributes("cli.command_started", { ...attributes, command: "private command" })).toBeUndefined();
  });
});
