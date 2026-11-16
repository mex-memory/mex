import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { posix } from "node:path";
const clip = (s, n = 32768) => String(s ?? "").slice(0, n);
const text = value => typeof value === "string" ? value : Array.isArray(value) ? value.filter(x => x.type === "text").map(x => x.text).join("\n") : JSON.stringify(value ?? "");
export function remap(path, oldRoot, newRoot) {
  const p = String(path ?? "").replaceAll("\\", "/"),
    old = oldRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const absolute = /^(?:[a-z]:\/|\/)/i.test(p) ? p : posix.join(old, p);
  if (absolute.toLowerCase() !== old.toLowerCase() && !absolute.toLowerCase().startsWith(old.toLowerCase() + "/")) {
    return "/outside-checkout";
  }
  const rel = absolute.slice(old.length).replace(/^\//, "");
  if (rel.split("/").includes("..")) {
    return "/outside-checkout";
  }
  return newRoot.replaceAll("\\", "/") + (rel ? "/" + rel : "");
}
export function convert(records, {
  session,
  project,
  checkout,
  oldRoot,
  subagent = false
}) {
  const events = [],
    pending = new Map();
  const base = {
    agent: "claude-code",
    session_id: session,
    agent_id: subagent ? "worker" : "",
    project_id: project,
    checkout,
    cwd: checkout
  };
  const emit = (kind, extra = {}) => events.push({
    ...base,
    kind,
    ...extra
  });
  emit(subagent ? "subagent_start" : "session_start", {
    source: "startup"
  });
  const mapPath = p => remap(p, oldRoot, checkout);
  for (const r of records) {
    if (r.type === "system" && r.subtype === "compact_boundary") {
      emit("post_compact");
      continue;
    }
    const content = r.message?.content;
    if (r.type === "assistant" && Array.isArray(content)) {
      for (const t of content) {
        if (t.type === "tool_use") {
          pending.set(t.id, t);
        }
      }
    }
    if (r.type !== "user") {
      continue;
    }
    const blocks = Array.isArray(content) ? content : [{
      type: "text",
      text: content
    }];
    const batch = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const t = pending.get(block.tool_use_id);
        if (!t) {
          continue;
        }
        pending.delete(block.tool_use_id);
        const input = t.input ?? {},
          raw = t.name,
          lower = raw.toLowerCase();
        let name = "other",
          normalized = {};
        if (lower === "read") {
          name = "read";
          normalized = {
            path: mapPath(input.file_path ?? input.path),
            offset: input.offset,
            limit: input.limit
          };
        } else if (lower === "edit") {
          name = "edit";
          normalized = {
            path: mapPath(input.file_path ?? input.path),
            old: clip(input.old_string),
            new: clip(input.new_string)
          };
        } else if (lower === "write") {
          name = "write";
          normalized = {
            path: mapPath(input.file_path ?? input.path),
            content: clip(input.content)
          };
        } else if (["bash", "shell", "powershell"].includes(lower)) {
          name = "shell";
          normalized = {
            command: clip(input.command, 8192).replaceAll(oldRoot, checkout).replaceAll(oldRoot.replaceAll("\\", "/"), checkout)
          };
        } else if (lower === "grep" || lower === "glob") {
          name = lower === "grep" ? "search" : "glob";
          normalized = {
            path: mapPath(input.path ?? oldRoot),
            pattern: clip(input.pattern, 4096),
            ...(lower === "grep" && (input.glob || input.type) ? { filter: input.glob ? String(input.glob) : "type:" + input.type } : {})
          };
        }
        const tool = {
          name,
          raw_name: raw,
          input: normalized,
          output: {
            text: clip(text(block.content)),
            ok: !block.is_error
          }
        };
        if (block.is_error) {
          emit("post_tool_failure", {
            tool
          });
        } else {
          batch.push(tool);
        }
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        emit("prompt", {
          prompt: {
            text: clip(block.text, 65536),
            typed: !subagent && !r.isSidechain && !r.isMeta
          }
        });
      }
    }
    if (batch.length) {
      emit("post_tool_batch", {
        batch: batch.slice(0, 64)
      });
    }
  }
  emit("session_end");
  return events;
}
export async function transcript(file) {
  const records = [];
  let bytes = 0;
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity
  })) {
    bytes += Buffer.byteLength(line);
    if (bytes > 128 * 1024 * 1024 || Buffer.byteLength(line) > 8 * 1024 * 1024) {
      throw Error("Transcript exceeds bound");
    }
    if (line.trim()) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}
