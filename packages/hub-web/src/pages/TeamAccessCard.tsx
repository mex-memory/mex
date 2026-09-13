import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { HubApi } from "../api/client";
import { Button } from "../components/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/primitives/card";
import { readTeamAccessState, writeTeamAccessState } from "../lib/team-access-state";
import homeStyles from "../styles/home.module.css";

const TeamAccessDialog = lazy(() => import("./TeamAccessDialog"));

export function TeamAccessCard({ api }: { api?: HubApi }) {
  const [contactSent, setContactSent] = useState(() => readTeamAccessState()?.contactSent === true);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const requestButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    if (api?.getContactPreference) void api.getContactPreference().then(preference => {
      if (!active) return;
      if (preference.status === "submitted") setContactSent(true);
      if (preference.status === "skipped" || preference.status === "unavailable") setDismissed(true);
    }).catch(() => { /* The local browser preference still applies. */ });
    return () => { active = false; };
  }, [api]);

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
            <CardTitle><h2 id="overview-team-access-heading">From mex</h2></CardTitle>
          </div>
        </CardHeader>
        <CardContent className={homeStyles.updatesContent}>
          {contactSent || dismissed ? (
            <p className={homeStyles.updatesBody}>{contactSent ? "Thanks for sharing your details. Keep using this Hub with your team." : "Keep using this Hub with your team."}</p>
          ) : (
            <>
              <p className={homeStyles.updatesLead}>This Hub already works with your team.</p>
              <p className={homeStyles.updatesBody}>
                Design-partner access is open for shared team memory.
              </p>
              <div className={homeStyles.updatesActions}>
                <Button ref={requestButtonRef} onClick={() => { setHasOpened(true); setOpen(true); }} size="sm" type="button" variant="outline">
                  Request access
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
            finalFocus={() => requestButtonRef.current ?? cardRef.current}
          />
        </Suspense>
      ) : null}
    </>
  );
}
