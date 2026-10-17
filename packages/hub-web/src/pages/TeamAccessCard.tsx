import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { HubApi } from "../api/client";
import type { HubTeamAccessStep } from "../api/telemetry";
import { Button } from "../components/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/primitives/card";
import { readTeamAccessState, writeTeamAccessState } from "../lib/team-access-state";
import homeStyles from "../styles/home.module.css";

const TeamAccessDialog = lazy(() => import("./TeamAccessDialog"));

/**
 * `reprompt` asks again someone who skipped earlier, once there is a reason to
 * share (a first Relay or a second contributor). Sent details are never asked again.
 */
export function TeamAccessCard({ api, reprompt = false }: { api?: HubApi; reprompt?: boolean }) {
  const [contactSent, setContactSent] = useState(() => readTeamAccessState()?.contactSent === true);
  const [declined, setDeclined] = useState<"skipped" | "unavailable" | null>(null);
  const [preferenceChecked, setPreferenceChecked] = useState(() => !api?.getContactPreference);
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const requestButtonRef = useRef<HTMLButtonElement>(null);
  const dismissed = declined === "unavailable" || (declined === "skipped" && !reprompt);
  const showRequest = !contactSent && !dismissed;

  useEffect(() => {
    let active = true;
    if (api?.getContactPreference) void api.getContactPreference().then(preference => {
      if (!active) return;
      if (preference.status === "submitted") setContactSent(true);
      if (preference.status === "skipped" || preference.status === "unavailable") setDeclined(preference.status);
    }).catch(() => { /* The local browser preference still applies. */ })
      .finally(() => { if (active) setPreferenceChecked(true); });
    return () => { active = false; };
  }, [api]);

  const recordStep = useCallback((step: HubTeamAccessStep) => {
    if (api?.recordTeamAccess) void api.recordTeamAccess(step);
  }, [api]);

  useEffect(() => {
    // Count a view only once the request is actually offered.
    if (preferenceChecked && showRequest) recordStep("card_viewed");
  }, [preferenceChecked, showRequest, recordStep]);

  const rememberContactSent = () => {
    writeTeamAccessState({ contactSent: true });
    setContactSent(true);
    if (api?.rememberContactPreference) void api.rememberContactPreference({ status: "submitted" }).catch(() => undefined);
  };

  return (
    <>
      <Card ref={cardRef} tabIndex={-1} className={homeStyles.updatesCard} role="region" aria-labelledby="overview-team-access-heading">
        <CardHeader className={homeStyles.panelHeader}>
          <div>
            <CardTitle><h2 id="overview-team-access-heading">Share this memory with your team</h2></CardTitle>
          </div>
        </CardHeader>
        <CardContent className={homeStyles.updatesContent}>
          {!showRequest ? (
            <p className={homeStyles.updatesBody}>{contactSent ? "Thanks for sharing your details. Keep using this Hub with your team." : "Keep using this Hub with your team."}</p>
          ) : (
            <>
              <p className={homeStyles.updatesLead}>This Hub already works with your team.</p>
              <div className={homeStyles.updatesActions}>
                <Button
                  ref={requestButtonRef}
                  onClick={() => { recordStep("button_clicked"); setHasOpened(true); setOpen(true); }}
                  size="sm"
                  type="button"
                >
                  Join the hosted beta
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {hasOpened ? (
        <Suspense fallback={<p role="status">Opening access request…</p>}>
          <TeamAccessDialog
            open={open}
            onOpenChange={setOpen}
            onContactSent={rememberContactSent}
            onStep={recordStep}
            finalFocus={() => requestButtonRef.current ?? cardRef.current}
          />
        </Suspense>
      ) : null}
    </>
  );
}

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
