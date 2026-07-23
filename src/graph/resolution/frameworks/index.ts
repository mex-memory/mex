import { expressResolver } from "./express.js";
import { nestjsResolver } from "./nestjs.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [expressResolver, nestjsResolver];
export { expressResolver } from "./express.js";
export { nestjsResolver } from "./nestjs.js";
