import type { MachineCheckout } from "@mex/hub-contracts/machine";
import { Check, Clock3, Power } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../components/primitives/badge";
import { Card, CardContent, CardHeader } from "../components/primitives/card";
import { localDateTime } from "./local-time";
import { CommandCard, CopyButton } from "./ui";
import styles from "./machine.module.css";

export function RelinkPage({ rejectedLink }: { rejectedLink: boolean }) {
  return (
    <CommandCard command="mex hub" title="Open the Hub from the terminal">
      <p>Run <code>mex hub</code> and open the link it prints. Your sign-in then lasts 30 days on this browser.</p>
      {rejectedLink && <p className={styles.signInNotice}>That sign-in link was already used or has expired.</p>}
    </CommandCard>
  );
}

function CheckoutStatus({ checkout }: { checkout: MachineCheckout }) {
  if (checkout.state === "on") {
    return <Badge variant="outline" className={styles.onBadge}><Check aria-hidden="true" />MEX is on</Badge>;
  }

  const offUntil = checkout.offUntil;
  if (checkout.state === "off until" && offUntil && Number.isFinite(Date.parse(offUntil))) {
    const localTime = localDateTime.format(new Date(offUntil));
    return <Badge variant="outline"><Clock3 aria-hidden="true" />Off until <time dateTime={offUntil}>{localTime}</time></Badge>;
  }
  return <Badge variant="outline"><Power aria-hidden="true" />MEX is off</Badge>;
}

export function RepoCheckouts({ checkouts }: { checkouts: MachineCheckout[] }) {
  if (checkouts.length === 0) return null;

  return (
    <details className={styles.checkoutDisclosure}>
      <summary className={styles.muted}>{checkouts.length} {checkouts.length === 1 ? "checkout" : "checkouts"}</summary>
      <ul aria-label="Checkouts" className={styles.checkouts} role="list">
        {checkouts.map((checkout) => (
          <li className={styles.checkoutRow} key={checkout.path}>
            <div className={styles.checkoutDetails}>
              <code>{checkout.path}</code>
              <CheckoutStatus checkout={checkout} />
            </div>
            <CopyButton path text={checkout.path} />
          </li>
        ))}
      </ul>
    </details>
  );
}

export function UnknownRepoPage({ homeHref }: { homeHref: string }) {
  return (
    <Card>
      <CardHeader><h1 className={styles.pageTitle}>This repo isn't known to MEX on this machine</h1></CardHeader>
      <CardContent><Link className={styles.textLink} to={homeHref}>All repos</Link></CardContent>
    </Card>
  );
}
