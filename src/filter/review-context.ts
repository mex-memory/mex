import { openHooksReadOnly } from "../record/index.js";
import type { RecordLocation } from "../record/location.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { hash } from "../judge/evidence.js";
import { FILTER_LIMITS, filterSession, type Message } from "./input.js";
import { deliveredContext, deliveredNoteLookup } from "./delivered.js";
import type { SourceRecord } from "./metadata.js";
import { replyContextDigest, replyContexts } from "./transcript.js";

export interface AgentReply { quote: string; text: string | null; }

/** Rebuild the exact masked reply for a local Review preview. The record holds only its hash. */
export function reviewReply(location: RecordLocation, project: string, record: SourceRecord): AgentReply {
  const safe = (text: string) => stripHidden(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const result: AgentReply = { quote: safe(record.quote), text: null };
  if (hasSecret(result.quote)) return { quote: "[quote withheld]", text: null };
  const source = record.source;
  if (!source.session || !source.row || !source.message_hash || !source.reply_context_hash || source.marks) return result;
  let hooks: ReturnType<typeof openHooksReadOnly>;
  try {
    hooks = openHooksReadOnly({ home: location.home });
    if (!hooks || hooks.diagnostic) return result;
    const session = hooks.get<{ checkout: string; agent: string }>("SELECT checkout,agent FROM sessions WHERE session_id=? AND project_id=?", source.session, project);
    if (!session || (session.agent !== "claude-code" && session.agent !== "codex")) return result;
    const meta = filterSession({ location }, project, session.checkout, source.session);
    if (!meta || meta.agent !== session.agent || !meta.transcript) return result;
    const live = hooks.get<{ text: string; marks: string; ts: string }>("SELECT text,marks,ts FROM journal WHERE id=? AND session_id=? AND kind='typed'", source.row, source.session);
    if (!live || live.marks || live.ts !== source.at) return result;
    const text = Array.from(live.text).slice(0, FILTER_LIMITS.characters).join("");
    if (hash(text) !== source.message_hash || !text.includes(record.quote)) return result;
    const { ids, masks } = deliveredContext(hooks, source.session, deliveredNoteLookup(location.home, project, session.checkout));
    if (masks === null) return result;
    const message: Message = { id: `m${source.row}`, row: source.row, session: source.session, at: source.at, marks: "", text, previous_reply: null, delivered: ids };
    const issue = replyContexts(meta.transcript, session.agent === "claude-code" ? "claude" : "codex", [message], "design", { checkout: session.checkout, notes: masks });
    if (issue || replyContextDigest(message) !== source.reply_context_hash || !message.previous_reply) return result;
    const reply = safe(message.previous_reply);
    return hasSecret(reply) ? result : { ...result, text: reply };
  } catch { return result; }
  finally { hooks?.close(); }
}
