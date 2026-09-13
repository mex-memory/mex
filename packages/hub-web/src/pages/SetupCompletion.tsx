import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Mail, Terminal, ArrowRight } from "lucide-react";
import type { HubApi } from "../api/client";
import { Button } from "../components/primitives/button";
import { Input } from "../components/primitives/input";
import styles from "../styles/setup.module.css";

export function SetupCompletion({ api, agentMemory, pending, onOpen }: {
  api: HubApi; agentMemory: boolean; pending: boolean; onOpen(): void;
}) {
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [installSkipped, setInstallSkipped] = useState(false);
  const [contactDismissed, setContactDismissed] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const installation = useQuery({ queryKey: ["setup", "installation"],
    queryFn: () => api.getSetupInstallation!(), enabled: Boolean(api.getSetupInstallation), retry: false,
    refetchInterval: query => query.state.data?.state === "running" ? 1000 : false });
  const contact = useQuery({ queryKey: ["contact", "preference"], queryFn: () => api.getContactPreference!(),
    enabled: Boolean(api.getContactPreference), retry: false, staleTime: Infinity });
  const install = useMutation({ mutationFn: () => api.installSetupGlobally!(),
    onSuccess: result => client.setQueryData(["setup", "installation"], result) });
  const send = useMutation({ mutationFn: () => api.submitSetupContact!({ email, name }),
    onSuccess: result => {
      if (result.ok) { setEmail(""); setName(""); client.setQueryData(["contact", "preference"], { status: "submitted" }); }
    } });
  const skip = useMutation({ mutationFn: () => api.rememberContactPreference!({ status: "skipped" }),
    onSuccess: result => client.setQueryData(["contact", "preference"], result) });
  const installing = install.isPending || installation.data?.state === "running";
  const sent = send.data?.ok || contact.data?.status === "submitted";
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };

  return <div className={styles.completion}>
    <div className={styles.completionHeading}>
      <span className={styles.completionCheck}><Check aria-hidden="true" /></span>
      <div><h3>You’re ready</h3><p>{agentMemory ? "Your agent memory is ready to use." : "Your project memory is set up and committed."}</p></div>
    </div>
    <div className={styles.nextSession}>
      <h4>Start a fresh agent session</h4>
      <p>Your new instructions and skills load in a new session. Try asking:</p>
      <blockquote>Read .mex/ROUTER.md and tell me what you know about this project.</blockquote>
      <p>Use <code>mex check</code> to check drift and <code>mex sync</code> to update memory.
        You can also use <code>npx mex-agent{installation.data ? `@${installation.data.version}` : ""} check</code> and <code>sync</code>.</p>
    </div>
    <div className={styles.completionCards}>
      {api.installSetupGlobally && !installSkipped ? <section className={styles.completionCard} aria-label="Optional global installation">
        <Terminal aria-hidden="true" /><span className={styles.optionalLabel}>Optional</span>
        <h4>Use mex from your terminal</h4>
        <p>Install the command on this computer so you can use it across your projects.</p>
        {installation.data ? <>
          <div className={styles.installCommand}><code>{installation.data.command}</code>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy install command" onClick={() => void copy(installation.data!.command)}>
              {copied ? <Check /> : <Copy />}
            </Button></div>
          <p role="status">{installation.data.message}</p>
        </> : <p>{installation.isError ? "Installation status is unavailable. You can skip this step and install later." : "Checking installation options…"}</p>}
        {install.isError ? <p role="alert">Installation could not start. Try again, or copy the command to your terminal.</p> : null}
        {installation.data?.state !== "succeeded" ? <div className={styles.actions}>
          <Button type="button" size="sm" disabled={installing || !installation.data} onClick={() => install.mutate()}>
            {installing ? "Installing…" : installation.data?.state === "failed" ? "Retry installation" : "Install globally"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={installing} onClick={() => setInstallSkipped(true)}>Skip</Button>
        </div> : null}
      </section> : null}
      {api.submitSetupContact && !contactDismissed && (sent || contact.data?.status === "unasked") ? <section className={styles.completionCard} aria-label="Optional contact details">
        <Mail aria-hidden="true" /><span className={styles.optionalLabel}>Optional</span>
        <h4>Help shape MEX</h4>
        {sent ? <p role="status">{send.data?.message ?? "Thanks — you’ve already shared your details."}</p> : <form onSubmit={event => { event.preventDefault(); send.mutate(); }}>
          <p>Open to a short conversation about your experience? Leave your email so we can follow up.</p>
          <label htmlFor="setup-contact-email">Email</label>
          <Input id="setup-contact-email" type="email" autoComplete="email" maxLength={320} required value={email} disabled={send.isPending} onChange={event => setEmail(event.target.value)} />
          <label htmlFor="setup-contact-name">Name <span>(optional)</span></label>
          <Input id="setup-contact-name" autoComplete="name" maxLength={200} value={name} disabled={send.isPending} onChange={event => setName(event.target.value)} />
          <p className={styles.contactPrivacy}>Sent through Web3Forms for follow-up about MEX. Contact details stay out of your repository and usage telemetry.</p>
          {send.isError || send.data?.ok === false ? <p role="alert">{send.data?.message ?? "Could not send your details. Try again, or skip."}</p> : null}
          <div className={styles.actions}>
            <Button type="submit" size="sm" disabled={send.isPending}>{send.isPending ? "Sending…" : "Send details"}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={send.isPending} onClick={() => { setContactDismissed(true); if (api.rememberContactPreference) skip.mutate(); }}>Skip</Button>
          </div>
        </form>}
      </section> : null}
    </div>
    {skip.isError ? <p role="status">Your choice could not be saved on this computer. You can continue; the invitation may appear again.</p> : null}
    {agentMemory ? <p className={styles.notice}>You can close this tab and continue with your agent.</p> : <div className={styles.footer}>
      <p>Explore your project memory in the Hub.</p>
      <Button type="button" disabled={pending || installing || send.isPending || skip.isPending} onClick={async () => {
        if (contact.data?.status === "unasked" && api.rememberContactPreference) {
          try { await skip.mutateAsync(); } catch { /* An optional preference cannot block the Hub. */ }
        }
        onOpen();
      }}>{pending ? "Opening…" : "Open Hub"}<ArrowRight aria-hidden="true" /></Button>
    </div>}
  </div>;
}
