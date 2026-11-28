import type { MachineCheckout, MachineProject } from "@mex/hub-contracts/machine";
import { ChevronRight, Folder, FolderGit2, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge, badgeVariants } from "../components/primitives/badge";
import { Card, CardContent, CardHeader } from "../components/primitives/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/primitives/tooltip";
import { cn } from "../lib/utils";
import { CommandCard, CopyButton } from "./ui";
import styles from "./machine.module.css";

const provisionalDescription = "History-based numbers may be incomplete (shallow or new repo)";

export function repoPath(id: string): string {
  return `/repos/${encodeURIComponent(id)}`;
}

export function RelinkPage({ rejectedLink }: { rejectedLink: boolean }) {
  return (
    <CommandCard command="mex hub" title="Open the Hub from the terminal">
      <p>Run <code>mex hub</code> and open the link it prints. Your sign-in then lasts 30 days on this browser.</p>
      {rejectedLink && <p className={styles.signInNotice}>That sign-in link was already used or has expired.</p>}
    </CommandCard>
  );
}

function CheckoutStatus({ checkout }: { checkout: MachineCheckout }) {
  if (checkout.state === "on") return <Badge variant="outline" className={styles.onBadge}>MEX is on</Badge>;

  const offUntil = checkout.offUntil;
  if (checkout.state === "off until" && offUntil && Number.isFinite(Date.parse(offUntil))) {
    const localTime = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(offUntil));
    return <Badge variant="outline">Off until <time dateTime={offUntil}>{localTime}</time></Badge>;
  }
  return <Badge variant="outline">MEX is off</Badge>;
}

function Checkouts({ checkouts, showState = false }: { checkouts: MachineCheckout[]; showState?: boolean }) {
  return (
    <ul aria-label="Checkouts" className={styles.checkouts} role="list">
      {checkouts.map((checkout) => (
        <li key={checkout.path}>
          <div className={styles.checkoutRow}>
            <div className={styles.checkoutDetails}>
              <code>{checkout.path}</code>
              {showState && <CheckoutStatus checkout={checkout} />}
            </div>
            <CopyButton path text={checkout.path} />
          </div>
          {!checkout.exists && (
            <p className={styles.missing}>
              <TriangleAlert aria-hidden="true" />
              <span>Folder not found at <code>{checkout.path}</code></span>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({ project }: { project: MachineProject }) {
  const Icon = project.kind === "git" ? FolderGit2 : Folder;
  return (
    <Card className={styles.projectCard}>
      <CardHeader className={styles.projectHeader}>
        <span className={styles.projectGlyph}><Icon aria-hidden="true" /></span>
        <div className={styles.projectIdentity}>
          <h2><Link to={repoPath(project.id)}>{project.name} <ChevronRight aria-hidden="true" /></Link></h2>
          <p>{project.kind === "git" ? "git repo" : "folder"}</p>
        </div>
        {project.provisional && (
          <Tooltip>
            <TooltipTrigger
              aria-description={provisionalDescription}
              className={cn(badgeVariants({ variant: "outline" }), styles.provisional)}
              closeOnClick={false}
              type="button"
            >
              provisional
            </TooltipTrigger>
            <TooltipContent role="tooltip">{provisionalDescription}</TooltipContent>
          </Tooltip>
        )}
      </CardHeader>
      {project.checkouts.length > 0 && (
        <CardContent className={styles.projectCheckouts}>
          <Checkouts checkouts={project.checkouts} />
        </CardContent>
      )}
    </Card>
  );
}

export function AllReposPage({ projects }: { projects: MachineProject[] }) {
  if (projects.length === 0) {
    return (
      <CommandCard command="mex" title="Welcome to MEX">
        <p>Run <code>mex</code> inside a repo to set it up. It shows up here.</p>
      </CommandCard>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>All repos</h1>
      <TooltipProvider>
        <ul className={styles.projects} role="list">
          {projects.map((project) => <li key={project.id}><ProjectCard project={project} /></li>)}
        </ul>
      </TooltipProvider>
    </div>
  );
}

export function RepoPage({ project }: { project: MachineProject }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>{project.name}</h1>
      {project.checkouts.length > 0 && (
        <Card>
          <CardContent><Checkouts checkouts={project.checkouts} showState /></CardContent>
        </Card>
      )}
    </div>
  );
}

export function UnknownRepoPage() {
  return (
    <Card>
      <CardHeader><h1 className={styles.pageTitle}>This repo isn't known to MEX on this machine</h1></CardHeader>
      <CardContent><Link className={styles.textLink} to="/">All repos</Link></CardContent>
    </Card>
  );
}
