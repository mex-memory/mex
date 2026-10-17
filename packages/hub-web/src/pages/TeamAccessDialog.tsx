import { useEffect, useId, useState, type ReactNode } from "react";
import { CheckCircle2, Mail, ShieldCheck, type LucideIcon } from "lucide-react";
import { Button } from "../components/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { cn } from "../lib/utils";
import type { HubTeamAccessStep } from "../api/telemetry";
import {
  TEAM_ACCESS_ENGINEERS_USING_AGENTS,
  TEAM_ACCESS_FOUND_MEX,
  TEAM_ACCESS_INSTALL_REASONS,
  TEAM_ACCESS_NEEDS,
  TEAM_ACCESS_REPO_KINDS,
  TEAM_ACCESS_TEAM_SIZES,
  boundCompany,
  boundEmail,
  boundMissing,
  boundName,
  buildTeamAccessContactPayload,
  buildTeamAccessFollowUpPayload,
  submitTeamAccessPayload,
  validateTeamAccessEmail,
} from "../lib/team-access-lead";
import styles from "../styles/team-access.module.css";

type PanelStep = "contact" | "details";

function AccessPanelIntro({
  description,
  icon: Icon,
  title,
  tone = "primary",
}: {
  description: string;
  icon: LucideIcon;
  title: string;
  tone?: "primary" | "success";
}) {
  return (
    <DialogHeader className={styles.header}>
      <div className={styles.intro}>
        <span aria-hidden="true" className={styles.mark} data-tone={tone}>
          <Icon />
        </span>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Share this memory with your team</p>
          <DialogTitle className={styles.title}>{title}</DialogTitle>
          <DialogDescription className={styles.description}>{description}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
  );
}

function AccessPanelBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

function OptionalChoice({
  disabled,
  id,
  label,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  id: string;
  label: string;
  onChange(value: string): void;
  options: readonly string[];
  value: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        <NativeSelectOption value="">Choose one</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

export default function TeamAccessDialog({
  open,
  onOpenChange,
  onContactSent,
  onStep,
  finalFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onContactSent(): void;
  onStep?(step: HubTeamAccessStep): void;
  finalFocus(): HTMLElement | null;
}) {
  const [step, setStep] = useState<PanelStep>("contact");
  const [engineersUsingAgents, setEngineersUsingAgents] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [foundMex, setFoundMex] = useState("");
  const [installReason, setInstallReason] = useState("");
  const [repoKind, setRepoKind] = useState("");
  const [need, setNeed] = useState("");
  const [missing, setMissing] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const engineersUsingAgentsId = useId();
  const nameId = useId();
  const emailId = useId();
  const companyId = useId();
  const teamSizeId = useId();
  const foundMexId = useId();
  const installReasonId = useId();
  const repoKindId = useId();
  const needId = useId();
  const missingId = useId();

  useEffect(() => {
    if (open) onStep?.("dialog_opened");
  }, [open, onStep]);

  const rememberContactSent = () => {
    onContactSent();
  };

  const closePanel = (nextOpen: boolean) => {
    if (submitting && !nextOpen) return;
    onOpenChange(nextOpen);
    if (nextOpen) return;
    setSubmitError(null);
    setFieldErrors({});
    if (step === "details") rememberContactSent();
  };

  const submitContact = async () => {
    const nextEmail = boundEmail(email);
    const errors = validateTeamAccessEmail(nextEmail);
    setFieldErrors(errors);
    setSubmitError(null);
    if (errors.email) return;

    setSubmitting(true);
    try {
      const result = await submitTeamAccessPayload(buildTeamAccessContactPayload({ email: nextEmail }));
      if (!result.ok) {
        setSubmitError(result.message);
        return;
      }
      onStep?.("submitted");
      rememberContactSent();
      setEmail(nextEmail);
      setStep("details");
    } finally {
      setSubmitting(false);
    }
  };

  const skipDetails = () => {
    rememberContactSent();
    onOpenChange(false);
    setSubmitError(null);
  };

  const submitDetails = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitTeamAccessPayload(buildTeamAccessFollowUpPayload({
        email,
        engineersUsingAgents,
        name: boundName(name),
        company: boundCompany(company),
        teamSize,
        foundMex,
        installReason,
        repoKind,
        need,
        missing: boundMissing(missing),
      }));
      if (!result.ok) {
        setSubmitError(result.message);
        return;
      }
      rememberContactSent();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={closePanel}>
      <DialogContent finalFocus={finalFocus} className={cn(styles.dialog, "max-w-[min(460px,calc(100vw-32px))] gap-0 p-0 sm:max-w-[460px]")}>
        {step === "contact" ? (
          <form
            className={styles.form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submitContact();
            }}
          >
            <AccessPanelIntro
              description="This Hub already works with your team."
              icon={Mail}
              title="Join the hosted beta"
            />
            <AccessPanelBody>
              <FieldGroup className={styles.fields}>
                <Field data-invalid={fieldErrors.email !== undefined || undefined}>
                  <FieldLabel htmlFor={emailId}>Email</FieldLabel>
                  <Input
                    aria-invalid={fieldErrors.email !== undefined || undefined}
                    autoComplete="email"
                    autoFocus
                    disabled={submitting}
                    id={emailId}
                    maxLength={320}
                    name="email"
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    placeholder="ada@example.com"
                    type="email"
                    value={email}
                  />
                  {fieldErrors.email ? <FieldError>{fieldErrors.email}</FieldError> : null}
                </Field>
                <p className={styles.privacy}>
                  <ShieldCheck aria-hidden="true" />
                  Used only to follow up about team access.
                </p>
                {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}
              </FieldGroup>
            </AccessPanelBody>
            <DialogFooter className={cn(styles.footer, "mx-0 mb-0 rounded-none bg-transparent px-[22px] pt-[14px] pb-[18px]")}>
              <Button disabled={submitting} type="submit">
                {submitting ? "Sending…" : "Join the hosted beta"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            className={styles.form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submitDetails();
            }}
          >
            <AccessPanelIntro
              description="Optional details help us follow up."
              icon={CheckCircle2}
              title="You’re on the list"
              tone="success"
            />
            <AccessPanelBody>
              <FieldGroup className={styles.fields}>
                <OptionalChoice disabled={submitting} id={engineersUsingAgentsId} label="How many engineers use agents on your repos?" onChange={setEngineersUsingAgents} options={TEAM_ACCESS_ENGINEERS_USING_AGENTS} value={engineersUsingAgents} />
                <Field>
                  <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                  <Input
                    autoComplete="name"
                    disabled={submitting}
                    id={nameId}
                    maxLength={200}
                    name="name"
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Ada Lovelace"
                    value={name}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={companyId}>Company</FieldLabel>
                  <Input
                    autoComplete="organization"
                    disabled={submitting}
                    id={companyId}
                    maxLength={200}
                    name="company"
                    onChange={(event) => setCompany(event.currentTarget.value)}
                    placeholder="Company name"
                    value={company}
                  />
                </Field>
                <OptionalChoice disabled={submitting} id={teamSizeId} label="Team size" onChange={setTeamSize} options={TEAM_ACCESS_TEAM_SIZES} value={teamSize} />
                <OptionalChoice disabled={submitting} id={foundMexId} label="How did you find mex?" onChange={setFoundMex} options={TEAM_ACCESS_FOUND_MEX} value={foundMex} />
                <OptionalChoice disabled={submitting} id={installReasonId} label="Why did you install it?" onChange={setInstallReason} options={TEAM_ACCESS_INSTALL_REASONS} value={installReason} />
                <OptionalChoice disabled={submitting} id={repoKindId} label="Your repo is" onChange={setRepoKind} options={TEAM_ACCESS_REPO_KINDS} value={repoKind} />
                <OptionalChoice disabled={submitting} id={needId} label="I need" onChange={setNeed} options={TEAM_ACCESS_NEEDS} value={need} />
                <Field>
                  <FieldLabel htmlFor={missingId}>What’s missing?</FieldLabel>
                  <Input
                    disabled={submitting}
                    id={missingId}
                    maxLength={240}
                    name="whats_missing"
                    onChange={(event) => setMissing(event.currentTarget.value)}
                    placeholder="One optional line"
                    value={missing}
                  />
                </Field>
                {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}
              </FieldGroup>
            </AccessPanelBody>
            <DialogFooter className={cn(styles.footer, "mx-0 mb-0 rounded-none bg-transparent px-[22px] pt-[14px] pb-[18px]")}>
              <Button disabled={submitting} onClick={skipDetails} type="button" variant="outline">
                Skip
              </Button>
              <Button disabled={submitting} type="submit">
                {submitting ? "Sending…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
