import { expressResolver } from "./express.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [expressResolver];
export { expressResolver } from "./express.js";
