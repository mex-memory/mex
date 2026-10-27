import { useEffect, useState } from "react";
import type { HubApi } from "../api/client";

/**
 * A first Relay or a second commit author is a reason to ask about team sharing
 * again. The caller already knows whether a Relay exists; Overview gets both
 * signals from its aggregate instead.
 */
export function useTeamAccessReprompt(api: HubApi, relayExists: boolean): boolean {
  const [moreThanOneContributor, setMoreThanOneContributor] = useState(false);
  useEffect(() => {
    let active = true;
    if (api.getRepositoryContributors) void api.getRepositoryContributors()
      .then(result => { if (active && result.moreThanOne) setMoreThanOneContributor(true); }, () => undefined);
    return () => { active = false; };
  }, [api]);
  return relayExists || moreThanOneContributor;
}
