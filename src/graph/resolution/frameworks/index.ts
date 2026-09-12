import { expressResolver } from "./express.js";
import { nextjsResolver } from "./nextjs.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [expressResolver, nextjsResolver];
export { expressResolver } from "./express.js";
export { nextjsResolver } from "./nextjs.js";
