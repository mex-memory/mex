import { resolve } from "node:path";
import type { MexConfig } from "../types.js";

/**
 * Rebuild `.mex/wiki.db` after a sync session reviewed Wiki entities, so
 * `wiki query`, `wiki for-code` and the Hub show what the session decided.
 *
 * Fails loudly: a rebuild that errors, or one that could not use a fresh code
 * graph (and so would store no health at all), throws rather than leave an
 * index that silently disagrees with the Markdown.
 */
export async function rebuildWikiIndexAfterSync(config: MexConfig): Promise<{ entityCount: number }> {
  const [{ createRepositoryGraphPort }, { publishWithGraph }, { wikiPrepareRebuildIndex }, { hasBlockingDiagnostic }] =
    await Promise.all([
      import("../graph/application-adapter.js"),
      import("../wiki/cli/grounding.js"),
      import("../wiki/service/write.js"),
      import("../wiki/model/diagnostic.js"),
    ]);
  const { value, unavailable } = await publishWithGraph(
    createRepositoryGraphPort(config.projectRoot),
    (graph) => wikiPrepareRebuildIndex({
      scaffoldRoot: resolve(config.scaffoldRoot),
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
      graph,
    }),
  );
  if (unavailable !== null) {
    throw new Error(`the code graph could not be used (${unavailable}), so no link health would be stored; run \`mex graph\`, then \`mex wiki rebuild-index\``);
  }
  if (hasBlockingDiagnostic(value.diagnostics)) {
    throw new Error(value.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  }
  return { entityCount: value.data.entityCount };
}
