/**
 * The wiki service — one definition, and the CLI is its first adapter.
 *
 * §15 says "CLI commands and the Hub must call this service rather than
 * implementing independent parsing or SQL", and §20.7 asks for exact schema
 * parity between the CLI, the service and any MCP adapter. Parity between three
 * implementations is a promise; parity through one definition is a property.
 * So everything a command can answer is exported here, the CLI never reaches
 * past it into `query/`, `operations/` or `migration/`, and a test walks
 * `COMMAND_BINDINGS` to assert that.
 *
 * ## Where P9 stops and P10 begins
 *
 * These are **synchronous** typed functions. Everything underneath is
 * `node:sqlite` and `readFileSync`, so an async surface here would be promises
 * wrapped around nothing. §7.2's `WikiEngine` facade — the async shape, with
 * `Promise` returns — is P10's, and it wraps this rather than re-deciding it.
 * P10 also owns §17's Hub data sufficiency and the §21 sweep.
 *
 * ## §16 is a tool surface, not a server
 *
 * There is no MCP server anywhere in this repository, and building one would
 * mean a new dependency and a scope this phase does not have. §16 asks to
 * "expose narrow tools corresponding to the service layer", which is what the
 * eight functions named in `surface.ts` are: declared input and output types,
 * bounded output, no raw SQL, no unrestricted file writes, no generic "replace
 * wiki", and plan-before-apply on the two that mutate. An MCP adapter, when
 * somebody wants one, is a thin translation over these.
 */

export * from "./surface.js";
export * from "./read.js";
export * from "./write.js";
export { wikiValidate, type ValidateData } from "./validate.js";
export * from "./hub.js";
export {
  isPrepareStage,
  SYNTHESIS_PREPARE_STAGES,
  wikiSynthesisBuild,
  wikiSynthesisPrepare,
  wikiSynthesisPropose,
  wikiPrepareSynthesisPropose,
  type BuildData,
  type PrepareData,
  type PrepareStage,
  type ProposeData,
  type SynthesisOptions,
  type SynthesisScope,
} from "./synthesis.js";
