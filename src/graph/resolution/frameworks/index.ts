import { expressResolver } from "./express.js";
import { springResolver } from "./spring.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [expressResolver, springResolver];
export { expressResolver } from "./express.js";
export { springResolver } from "./spring.js";
