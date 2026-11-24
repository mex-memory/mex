import { remap } from '../delivery-replay/convert.mjs';

const text = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((block) => ['text', 'input_text', 'output_text'].includes(block.type)).map((block) => block.text).join('\n') : '';

export function replayEvents(records, { agent, log, checkout, session, checkout_root: oldRoot }) {
  const codex = agent === 'codex';
  const root = oldRoot ?? (codex ? records.find((row) => row.type === 'session_meta')?.payload?.cwd
    : records.find((row) => row.cwd)?.cwd);
  if (typeof root !== 'string' || !/^(?:[a-z]:[\\/]|\/)/i.test(root) || root.length < 2) throw new Error('Missing recorded checkout');
  const model = codex ? records.find((row) => row.type === 'turn_context' && row.payload?.model)?.payload.model
    : records.find((row) => row.type === 'assistant' && row.message?.model !== '<synthetic>' && row.message?.model)?.message.model;
  const events = [];
  const emit = (event, data) => events.push({ event, input: {
    hook_event_name: event, session_id: session, transcript_path: log, cwd: checkout, model, ...data,
  } });
  emit('SessionStart', { source: 'startup' });
  const calls = new Map();
  if (codex) {
    for (const { type, payload } of records) {
      if (!payload) continue;
      if (type === 'compacted') emit('PostCompact', { trigger: 'auto' });
      if (type !== 'response_item') continue;
      if (payload.type === 'message' && payload.role === 'user') {
        const prompt = text(payload.content);
        if (prompt && !prompt.startsWith('<')) emit('UserPromptSubmit', { prompt });
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const args = payload.type === 'function_call' ? JSON.parse(payload.arguments || '{}') : { command: payload.input };
        if (payload.name === 'exec_command') args.command ??= args.cmd;
        if (payload.name === 'apply_patch' && typeof args.command === 'string') {
          args.command = args.command.replace(/^(\*\*\* (?:Add File:|Delete File:|Update File:|Move to:) )(.+)$/gm,
            (_line, prefix, path) => prefix + remap(path, root, checkout));
        }
        const tool = { tool_name: payload.name, tool_input: args, tool_use_id: payload.call_id };
        calls.set(payload.call_id, tool);
        emit('PreToolUse', tool);
      }
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const tool = calls.get(payload.call_id);
        if (!tool) continue;
        calls.delete(payload.call_id);
        emit('PostToolUse', { ...tool, tool_response: text(payload.output) });
      }
    }
  } else {
    for (const row of records) {
      if (row.type === 'system' && row.subtype === 'compact_boundary') emit('PostCompact', { trigger: row.compactMetadata?.trigger ?? 'auto' });
      const content = row.message?.content;
      if (row.type === 'assistant' && Array.isArray(content)) {
        for (const block of content.filter((item) => item.type === 'tool_use')) {
          const input = { ...block.input };
          for (const key of ['file_path', 'path']) {
            if (typeof input[key] === 'string') input[key] = remap(input[key], root, checkout);
          }
          const tool = { tool_name: block.name, tool_input: input, tool_use_id: block.id };
          calls.set(block.id, tool);
          emit('PreToolUse', tool);
        }
      }
      if (row.type !== 'user' || row.isCompactSummary) continue;
      const prompt = text(content);
      if (prompt && !row.isMeta && !row.isSidechain && !prompt.startsWith('<')) emit('UserPromptSubmit', { prompt });
      const batch = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
        const tool = calls.get(block.tool_use_id);
        calls.delete(block.tool_use_id);
        const output = text(block.content);
        if (block.is_error) emit('PostToolUseFailure', { ...tool, error: output });
        else batch.push({ ...tool, tool_response: output });
      }
      if (batch.length) emit('PostToolBatch', { tool_calls: batch });
    }
    emit('SessionEnd', { reason: 'other' });
  }
  return events;
}
