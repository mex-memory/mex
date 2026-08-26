/**
 * Web UI defaults, in their own dependency-free module so `cli.ts` can name
 * them in `--help` without eagerly pulling node:http and the engine readers
 * into every CLI invocation.
 *
 * 3847 is deliberately outside the range dev servers habitually claim, so
 * `mex ui` rarely collides with whatever the project itself is running.
 */
export const DEFAULT_UI_PORT = 3847;

export const DEFAULT_UI_HOST = "127.0.0.1";
