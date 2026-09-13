import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type {
  CapabilitiesResponse,
  CapabilityStatus,
  HomeResponse,
} from "../api/types";
import { Badge } from "../components/primitives/badge";
import { Button } from "../components/primitives/button";
import { Kbd } from "../components/primitives/kbd";
import { Separator } from "../components/primitives/separator";
import { cn } from "../lib/utils";
import styles from "../styles/shell.module.css";
import mexMascot from "../../../../mascot/mex-mascot.svg?no-inline";
import {
  navigationGroups,
  navigationItems,
  navigationItemsForGroup,
  navigationItemsForPlacement,
  type NavigationCountSource,
  type NavigationGroup,
  type NavigationGroupId,
  type NavigationItem,
} from "./navigation";
import { SidebarTooltip } from "./SidebarTooltip";
import { useHubOnboarding } from "./HubOnboarding";

type ExpansionState = Record<NavigationGroupId, boolean>;

const LOCALITY_EXPLANATION = "MEX runs on this device. Canonical team records are shared when committed and pushed; drafts and indexes remain local to this checkout.";

const countLabels: Record<NavigationCountSource, (count: number) => string> = {
  inbox: (count) => `${count} proposals for team review.`,
  relays: (count) => `${count} open Relays for you.`,
  "active-jobs": (count) => `${count} active system operations.`,
};

export function routeMatches(pathname: string, path: string): boolean {
  return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
}

function activeGroup(pathname: string): NavigationGroupId | undefined {
  return navigationItems.find((item) => item.group && routeMatches(pathname, item.path))?.group;
}

function initialExpansion(pathname: string): ExpansionState {
  const currentGroup = activeGroup(pathname);
  return navigationGroups.reduce<ExpansionState>((state, group) => ({
    ...state,
    [group.id]: group.defaultExpanded || group.id === currentGroup,
  }), {
    "project-memory": false,
    teamwork: false,
    system: false,
  });
}

function capabilityStatus(
  capabilities: CapabilitiesResponse | undefined,
  item: NavigationItem,
): CapabilityStatus | undefined {
  if (!capabilities || item.availability.kind !== "runtime") return undefined;
  const capability = capabilities[item.availability.capability];
  return "read" in capability ? capability.read : capability;
}

function countBadge(count: number | undefined, source: NavigationCountSource): ReactNode {
  if (!count) return null;
  return (
    <Badge aria-label={countLabels[source](count)} variant="secondary">
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

function itemCount(home: HomeResponse | undefined, item: NavigationItem): number | undefined {
  if (!home || !item.countSource) return undefined;
  if (item.countSource === "inbox") {
    return home.attention.inbox.availability === "available"
      ? home.attention.inbox.teamReviewCount
      : undefined;
  }
  if (item.countSource === "relays") {
    return home.attention.relays.availability === "available"
      ? home.attention.relays.readyToTakeCount + home.attention.relays.inYourHandsCount
      : undefined;
  }
  return undefined;
}

function groupCount(
  capabilities: CapabilitiesResponse | undefined,
  group: NavigationGroup,
  home: HomeResponse | undefined,
): number | undefined {
  if (group.countSource !== "active-jobs" || !home) return undefined;
  const jobs = navigationItems.find((item) => item.id === "jobs");
  if (jobs && capabilityStatus(capabilities, jobs)?.availability === "unavailable") return undefined;
  return home.jobs.availability === "available" ? home.jobs.activeCount : undefined;
}

function identityText(home: HomeResponse | undefined): string {
  if (!home || home.actor.kind === "unknown") return "Set team identity";
  if (home.actor.kind === "member") return home.actor.displayName;
  return `Using Git: ${home.actor.name ?? home.actor.email}`;
}

function NavigationLink({
  capabilities,
  home,
  item,
  launcher = false,
}: {
  capabilities?: CapabilitiesResponse;
  home?: HomeResponse;
  item: NavigationItem;
  launcher?: boolean;
}) {
  const status = capabilityStatus(capabilities, item);
  const unavailableReason = status?.availability === "unavailable" ? status.reason : undefined;
  const runtimeUnavailable = unavailableReason !== undefined;
  const Icon = item.icon;
  const contents = (
    <>
      <Icon aria-hidden="true" />
      <span>{item.label}</span>
      {launcher ? (
        <Kbd aria-hidden="true">/</Kbd>
      ) : runtimeUnavailable ? (
        <Badge variant="outline">Unavailable</Badge>
      ) : item.countSource ? (
        countBadge(itemCount(home, item), item.countSource)
      ) : null}
    </>
  );
  const link = (describedBy?: string) => (
    <NavLink
      end={item.path === "/"}
      aria-describedby={describedBy}
      aria-description={unavailableReason}
      aria-keyshortcuts={launcher ? "/" : undefined}
      className={({ isActive }) => cn(
        launcher ? styles.searchLauncher : styles.navLink,
        isActive && (launcher ? styles.searchLauncherActive : styles.navLinkActive),
      )}
      data-onboarding={item.id}
      to={item.path}
    >
      {contents}
    </NavLink>
  );

  return unavailableReason ? (
    <SidebarTooltip content={unavailableReason}>
      {({ id }) => link(id)}
    </SidebarTooltip>
  ) : link();
}

function NavigationList({
  capabilities,
  home,
  items,
}: {
  capabilities?: CapabilitiesResponse;
  home?: HomeResponse;
  items: readonly NavigationItem[];
}) {
  return (
    <ul className={styles.navList}>
      {items.map((item) => (
        <li key={item.id}>
          <NavigationLink capabilities={capabilities} home={home} item={item} />
          {item.id === "team" ? <small className={styles.identityText}>{identityText(home)}</small> : null}
        </li>
      ))}
    </ul>
  );
}

function DisclosureGroup({
  active,
  capabilities,
  expanded,
  group,
  home,
  onToggle,
}: {
  active: boolean;
  capabilities?: CapabilitiesResponse;
  expanded: boolean;
  group: NavigationGroup;
  home?: HomeResponse;
  onToggle: () => void;
}) {
  const contentId = `${group.id}-navigation`;
  const labelId = `${group.id}-navigation-label`;
  const count = groupCount(capabilities, group, home);

  return (
    <section aria-labelledby={labelId} className={styles.navGroup} data-onboarding={`group-${group.id}`}>
      <h2 className={styles.groupHeading}>
        <Button
          aria-controls={contentId}
          aria-expanded={expanded}
          className={styles.groupDisclosure}
          data-active={active && !expanded ? "true" : undefined}
          data-expanded={expanded ? "true" : "false"}
          id={labelId}
          onClick={onToggle}
          size="xs"
          type="button"
          variant="ghost"
        >
          <span>{group.label}</span>
          <span className={styles.groupDisclosureMeta}>
            {group.countSource ? countBadge(count, group.countSource) : null}
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </span>
        </Button>
      </h2>
      <div id={contentId} hidden={!expanded}>
        <NavigationList capabilities={capabilities} home={home} items={navigationItemsForGroup(group.id)} />
      </div>
    </section>
  );
}

export function HubSidebar({
  capabilities,
  home,
}: {
  capabilities?: CapabilitiesResponse;
  home?: HomeResponse;
}) {
  const location = useLocation();
  const onboarding = useHubOnboarding();
  const [expanded, setExpanded] = useState<ExpansionState>(() => initialExpansion(location.pathname));
  const previousPath = useRef(location.pathname);
  const currentGroup = activeGroup(location.pathname);
  const revealed: ExpansionState = {
    ...expanded,
    ...Object.fromEntries((onboarding?.revealGroups ?? []).map((id) => [id, true])),
  };
  const launcher = navigationItemsForPlacement("launcher")[0];
  const topLevelItems = navigationItemsForPlacement("primary");
  const footerItems = navigationItemsForPlacement("footer");
  const primaryGroups = navigationGroups.filter((group) => group.placement === "primary");
  const footerGroups = navigationGroups.filter((group) => group.placement === "footer");

  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    const enteredGroup = activeGroup(location.pathname);
    if (!enteredGroup) return;
    setExpanded((current) => current[enteredGroup]
      ? current
      : { ...current, [enteredGroup]: true });
  }, [location.pathname]);

  function toggleGroup(group: NavigationGroupId) {
    setExpanded((current) => ({ ...current, [group]: !current[group] }));
  }

  return (
    <aside aria-label="Project Hub navigation" className={styles.sidebar} data-onboarding="sidebar">
      <div className={styles.sidebarHeader}>
        <div className={styles.brand} data-onboarding="brand">
          <span className={styles.brandMark} aria-hidden="true">
            <img alt="" height="32" src={mexMascot} width="32" />
          </span>
          <span className={styles.brandWordmark}>
            <strong>MEX</strong>
            <small>Hub</small>
          </span>
        </div>
        {launcher ? <NavigationLink capabilities={capabilities} home={home} item={launcher} launcher /> : null}
      </div>

      <Separator className={styles.sidebarSeparator} />

      <div className={styles.navScroller} data-sidebar-scroll="true">
        <nav className={styles.nav} aria-label="Primary">
          <NavigationList capabilities={capabilities} home={home} items={topLevelItems} />
          {primaryGroups.map((group) => (
            <DisclosureGroup
              active={group.id === currentGroup}
              capabilities={capabilities}
              expanded={revealed[group.id]}
              group={group}
              home={home}
              key={group.id}
              onToggle={() => toggleGroup(group.id)}
            />
          ))}
        </nav>
      </div>

      <footer className={styles.sidebarFooter}>
        <Separator className={styles.sidebarSeparator} />
        <nav className={styles.footerNavigation} aria-label="Project utilities">
          <ul className={styles.footerList}>
            {footerItems.map((item) => (
              <li key={item.id}>
                <NavigationLink capabilities={capabilities} home={home} item={item} />
                {item.id === "team" ? <small className={styles.identityText}>{identityText(home)}</small> : null}
              </li>
            ))}
          </ul>
          {footerGroups.map((group) => (
            <DisclosureGroup
              active={group.id === currentGroup}
              capabilities={capabilities}
              expanded={revealed[group.id]}
              group={group}
              home={home}
              key={group.id}
              onToggle={() => toggleGroup(group.id)}
            />
          ))}
        </nav>
        <SidebarTooltip content={LOCALITY_EXPLANATION}>
          {({ id }) => (
            <div
              aria-describedby={id}
              aria-description={LOCALITY_EXPLANATION}
              aria-label="Runs locally. Shared records use Git."
              className={styles.locality}
              data-onboarding="locality"
              role="note"
              tabIndex={0}
            >
              <ShieldCheck aria-hidden="true" />
              <span><strong>Runs locally</strong><small>Shared records use Git</small></span>
            </div>
          )}
        </SidebarTooltip>
      </footer>
    </aside>
  );
}
