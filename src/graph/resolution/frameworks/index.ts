import { expressResolver } from "./express.js";
import { fastAPIResolver } from "./fastapi.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [expressResolver, fastAPIResolver];
export { expressResolver } from "./express.js";
export { fastAPIResolver } from "./fastapi.js";
