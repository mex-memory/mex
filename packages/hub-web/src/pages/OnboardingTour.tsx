import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheck, X } from "lucide-react";
import mexMascot from "../../../../mascot/mex-mascot.svg?no-inline";
import { hubOnboardingSteps, type OnboardingStep } from "../app/onboarding";
import { Button } from "../components/primitives/button";
import { boxesForTargets, placeCallout, unionBoxes, type SpotlightBox } from "../lib/onboarding-spotlight";
import styles from "../styles/onboarding.module.css";

export function OnboardingTour({
  projectName,
  stepIndex,
  onStepChange,
  onDismiss,
  onFinish,
}: {
  projectName?: string;
  stepIndex: number;
  onStepChange(index: number): void;
  onDismiss(): void;
  onFinish(path?: string): void;
}) {
  const steps = hubOnboardingSteps(projectName);
  const lastIndex = steps.length - 1;
  const safeIndex = Math.min(Math.max(stepIndex, 0), lastIndex);
  const step = steps[safeIndex];
  const calloutRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [boxes, setBoxes] = useState<SpotlightBox[]>([]);
  const [callout, setCallout] = useState({ top: 96, left: 256 });

  useLayoutEffect(() => {
    if (!step) return undefined;

    function measure() {
      const next = boxesForTargets(document, step.targets);
      setBoxes(next);
      const anchor = unionBoxes(next) ?? { top: 96, left: 16, width: 232, height: 240 };
      const size = calloutRef.current?.getBoundingClientRect();
      setCallout(placeCallout(
        anchor,
        { width: size?.width ?? 380, height: size?.height ?? 320 },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    }

    const frame = window.requestAnimationFrame(measure);
    const scroller = document.querySelector("[data-sidebar-scroll]");
    window.addEventListener("resize", measure);
    scroller?.addEventListener("scroll", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      scroller?.removeEventListener("scroll", measure);
    };
  }, [projectName, safeIndex, step?.id]);

  useEffect(() => {
    primaryRef.current?.focus();
  }, [safeIndex]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  if (!step) return null;
  const StepIcon = step.icon;
  const spotlight = unionBoxes(boxes);

  const goNext = () => {
    if (safeIndex >= lastIndex) {
      onFinish(step.finishPath);
      return;
    }
    onStepChange(safeIndex + 1);
  };

  return createPortal(
    <div className={styles.layer}>
      <div className={styles.catch} onClick={onDismiss} />
      {spotlight ? (
        <div
          aria-hidden="true"
          className={styles.spot}
          style={{ top: spotlight.top, left: spotlight.left, width: spotlight.width, height: spotlight.height }}
        />
      ) : null}
      <div
        ref={calloutRef}
        aria-describedby="hub-onboarding-description"
        aria-labelledby="hub-onboarding-title"
        aria-modal="false"
        className={styles.callout}
        role="dialog"
        style={{ top: callout.top, left: callout.left }}
      >
        <Button
          aria-label="Close"
          className={styles.close}
          onClick={onDismiss}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
        <div className={styles.intro}>
          {step.showMascot ? (
            <img alt="" className={styles.mascot} height="56" src={mexMascot} width="56" />
          ) : (
            <span aria-hidden="true" className={styles.iconMark}>
              <StepIcon />
            </span>
          )}
          <div>
            <p className={styles.eyebrow}>{step.eyebrow}</p>
            <h2 className={styles.title} id="hub-onboarding-title">{step.title}</h2>
            <p className={styles.description} id="hub-onboarding-description">{step.description}</p>
          </div>
        </div>
        <OnboardingStepBody step={step} />
        <div className={styles.footer}>
          <div aria-hidden="true" className={styles.progress}>
            {steps.map((candidate, index) => (
              <span
                className={styles.dot}
                data-current={index === safeIndex}
                key={candidate.id}
              />
            ))}
          </div>
          <span className="sr-only">{`Step ${safeIndex + 1} of ${steps.length}`}</span>
          <div className={styles.actions}>
            {step.secondary ? (
              <Button
                onClick={() => {
                  if (step.finishPath !== undefined) onFinish();
                  else onDismiss();
                }}
                type="button"
                variant="ghost"
              >
                {step.secondary}
              </Button>
            ) : null}
            <Button onClick={goNext} ref={primaryRef} type="button">
              {step.primary}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OnboardingStepBody({ step }: { step: OnboardingStep }) {
  if (step.features?.length) {
    return (
      <ul className={styles.features}>
        {step.features.map((feature) => {
          const FeatureIcon = feature.icon;
          return (
            <li className={styles.feature} key={feature.title}>
              <span aria-hidden="true" className={styles.featureIcon}>
                <FeatureIcon />
              </span>
              <div>
                <p className={styles.featureTitle}>{feature.title}</p>
                <p className={styles.featureDetail}>{feature.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <p className={styles.locality}>
      <ShieldCheck aria-hidden="true" />
      The highlighted control stays visible. The rest of the Hub is only dimmed.
    </p>
  );
}
