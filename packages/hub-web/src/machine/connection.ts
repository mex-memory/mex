import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bootstrapSession, getProjects, getSession, heartbeat, HubNetworkError, isUnauthorized } from "./api";

const SESSION_KEY = ["machine", "session"];
const PROJECTS_KEY = ["machine", "projects"];
const RECOVERY_INTERVAL = 10_000;
const HEARTBEAT_INTERVAL = 60_000;

function readSignInLink(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get("token");
}

async function exchangeSignInLink(token: string): Promise<void> {
  const exchange = bootstrapSession(token);
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}`);
  await exchange;
}

export function useMachineConnection() {
  const queryClient = useQueryClient();
  const [connectionLost, setConnectionLost] = useState(false);
  const rejectedLink = useRef(false);

  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const token = readSignInLink();
      if (token !== null) {
        rejectedLink.current = false;
        try {
          await exchangeSignInLink(token);
        } catch (error) {
          rejectedLink.current = isUnauthorized(error);
          if (error instanceof HubNetworkError) setConnectionLost(true);
        }
      }

      const current = await getSession().catch((error: unknown) => {
        if (isUnauthorized(error)) return null;
        if (error instanceof HubNetworkError) setConnectionLost(true);
        throw error;
      });
      setConnectionLost(false);
      if (!current || rejectedLink.current) {
        queryClient.removeQueries({ queryKey: PROJECTS_KEY });
        queryClient.removeQueries({ queryKey: ["home"] });
        queryClient.removeQueries({ queryKey: ["jobs"] });
        queryClient.removeQueries({ queryKey: ["knowledge"] });
      }
      return { current: rejectedLink.current ? null : current, rejectedLink: rejectedLink.current };
    },
    retry: false,
    networkMode: "always",
    refetchInterval: connectionLost ? RECOVERY_INTERVAL : false,
    refetchIntervalInBackground: true,
  });

  const refreshSession = session.refetch;
  useEffect(() => {
    async function onHashChange() {
      if (readSignInLink() === null) return;
      await refreshSession({ cancelRefetch: false });
      // A session check already in progress may have read the previous URL.
      if (readSignInLink() !== null) void refreshSession({ cancelRefetch: false });
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [refreshSession]);

  const projects = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: async () => {
      try {
        return await getProjects();
      } catch (error) {
        if (error instanceof HubNetworkError) setConnectionLost(true);
        if (isUnauthorized(error)) void refreshSession({ cancelRefetch: false });
        throw error;
      }
    },
    enabled: Boolean(session.data?.current) && !connectionLost,
    retry: false,
    networkMode: "always",
  });

  const checkSession = useCallback(() => { void refreshSession({ cancelRefetch: false }); }, [refreshSession]);
  const reportDataError = useCallback((error: unknown) => {
    if (error instanceof HubNetworkError) setConnectionLost(true);
    if (isUnauthorized(error)) checkSession();
  }, [checkSession]);

  useHeartbeat(session.data?.current?.csrfToken, setConnectionLost, refreshSession);
  return { session, projects, connectionLost, checkSession, reportDataError };
}

function useHeartbeat(
  csrfToken: string | undefined,
  setConnectionLost: (value: boolean) => void,
  refreshSession: (options: { cancelRefetch: boolean }) => Promise<unknown>,
) {
  useEffect(() => {
    if (!csrfToken) return;
    let active = true;
    let timer: number | undefined;

    const send = async () => {
      try {
        await heartbeat(csrfToken);
      } catch (error) {
        if (!active) return;
        if (error instanceof HubNetworkError) setConnectionLost(true);
        else void refreshSession({ cancelRefetch: false });
        return;
      }
      // Check for updates and renew the sign-in on long-lived tabs.
      if (active) void refreshSession({ cancelRefetch: false });
    };

    function schedule(immediate: boolean) {
      window.clearInterval(timer);
      if (document.visibilityState !== "visible") return;
      if (immediate) void send();
      timer = window.setInterval(send, HEARTBEAT_INTERVAL);
    }

    const onVisibilityChange = () => schedule(true);
    schedule(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [csrfToken, refreshSession, setConnectionLost]);
}
