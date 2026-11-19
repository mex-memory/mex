import type { SourceHost } from "./forge.js";
import { githubInventory, githubRepository, githubReviews } from "./github.js";
import { gitlabInventory, gitlabRepository, gitlabReviews } from "./gitlab.js";
import type { Forge } from "./source.js";

export const hosts: Record<Forge, SourceHost> = {
  "github.com": { access: githubRepository, inventory: githubInventory, reviews: githubReviews },
  "gitlab.com": { access: gitlabRepository, inventory: gitlabInventory, reviews: gitlabReviews },
};
