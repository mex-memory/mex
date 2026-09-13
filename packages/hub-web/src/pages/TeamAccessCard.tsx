import { lazy, Suspense, useRef, useState } from "react";
import { Button } from "../components/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/primitives/card";
import { readTeamAccessState, writeTeamAccessState } from "../lib/team-access-state";
import homeStyles from "../styles/home.module.css";

const TeamAccessDialog = lazy(() => import("./TeamAccessDialog"));

export function TeamAccessCard() {
  const [contactSent, setContactSent] = useState(() => readTeamAccessState()?.contactSent === true);
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const requestButtonRef = useRef<HTMLButtonElement>(null);

  const rememberContactSent = () => {
    writeTeamAccessState({ contactSent: true });
    setContactSent(true);
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
          {contactSent ? (
            <p className={homeStyles.updatesBody}>You’re on the list. Keep using this Hub with your team.</p>
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
