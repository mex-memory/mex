import { expressResolver } from "./express.js";
import { hibernateResolver } from "./hibernate.js";
import { springBootResolver } from "./spring-boot.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [
  expressResolver,
  springBootResolver,
  hibernateResolver,
];
export { expressResolver } from "./express.js";
export { springBootResolver } from "./spring-boot.js";
export { hibernateResolver } from "./hibernate.js";
