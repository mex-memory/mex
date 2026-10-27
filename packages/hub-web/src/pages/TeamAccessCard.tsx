import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import type { HubApi } from "../api/client";
import type { ContactPreference } from "@mex/hub-contracts/contact";
import type { HubTeamAccessStep } from "../api/telemetry";
import { Button } from "../components/primitives/button";
import { readTeamAccessState, writeTeamAccessState } from "../lib/team-access-state";
import styles from "../styles/team-access-card.module.css";

const TeamAccessDialog = lazy(() => import("./TeamAccessDialog"));

/**
 * `reprompt` asks again someone who skipped earlier, once there is a reason to
 * share (a first Relay or a second contributor). Sent details are never asked again.
 */
export function TeamAccessCard({ api, reprompt = false, preference, onContactSent }: {
  api?: HubApi;
  reprompt?: boolean;
  /** Setup shares its preference; null means it is still loading. */
  preference?: ContactPreference | null;
  onContactSent?(): void;
}) {
  const [contactSent, setContactSent] = useState(() => readTeamAccessState()?.contactSent === true);
  const [localPreference, setLocalPreference] = useState<ContactPreference | null>(() => api?.getContactPreference ? null : { status: "unasked" });
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const headingId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const requestButtonRef = useRef<HTMLButtonElement>(null);
  const currentPreference = preference === undefined ? localPreference : preference;
  const submitted = contactSent || currentPreference?.status === "submitted";
  const dismissed = currentPreference?.status === "unavailable" || (currentPreference?.status === "skipped" && !reprompt);
  const showRequest = currentPreference !== null && !submitted && !dismissed;

  useEffect(() => {
    if (preference !== undefined) return;
    let active = true;
    void api?.getContactPreference?.().then(value => {
      if (active) setLocalPreference(value);
    }).catch(() => { if (active) setLocalPreference({ status: "unasked" }); });
    return () => { active = false; };
  }, [api, preference]);

  const recordStep = useCallback((step: HubTeamAccessStep) => {
    void api?.recordTeamAccess?.(step);
  }, [api]);

  useEffect(() => {
    // Count a view only once the request is actually offered.
    if (showRequest) recordStep("card_viewed");
  }, [showRequest, recordStep]);

  const rememberContactSent = () => {
    writeTeamAccessState({ contactSent: true });
    setContactSent(true);
    onContactSent?.();
    void api?.rememberContactPreference?.({ status: "submitted" }).catch(() => undefined);
  };

  return (
    <>
      <section ref={cardRef} tabIndex={-1} className={styles.card} aria-labelledby={headingId}>
        <header className={styles.header}>
          <h2 id={headingId}>Share this memory with your team</h2>
        </header>
        <div className={styles.content}>
          {!showRequest ? (
            <p className={styles.body}>{submitted ? "Thanks for sharing your details. Keep using this Hub with your team." : "Keep using this Hub with your team."}</p>
          ) : (
            <>
              <p className={styles.lead}>This Hub already works with your team.</p>
              <div className={styles.actions}>
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
        </div>
      </section>
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
