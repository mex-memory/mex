import {
  Activity,
  Code2,
  Compass,
  GitPullRequestArrow,
  HeartPulse,
  Inbox,
  Network,
  Search,
  Send,
  Settings2,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { NavigationGroupId } from "./navigation";

export interface OnboardingFeature {
  title: string;
  detail: string;
  icon: LucideIcon;
}

export interface OnboardingStep {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  targets: readonly string[];
  revealGroups?: readonly NavigationGroupId[];
  features?: readonly OnboardingFeature[];
  showMascot?: boolean;
  primary: string;
  secondary?: string;
  finishPath?: string;
}

export function hubOnboardingSteps(projectName?: string): readonly OnboardingStep[] {
  const project = projectName?.trim() ? projectName.trim() : "this checkout";
  return [
    {
      id: "welcome",
      eyebrow: "Project Hub",
      title: "Welcome to your local Hub",
      description: `This sidebar is the control room for ${project}. Context, code, and team memory stay on this device. Canonical records share only when you commit and push.`,
      icon: Compass,
      targets: ["sidebar"],
      revealGroups: ["project-memory", "teamwork"],
      showMascot: true,
      primary: "Show me around",
      secondary: "Skip tour",
    },
    {
      id: "project",
      eyebrow: "Project",
      title: "Read the project, then add to it",
      icon: Network,
      targets: ["group-project-memory"],
      revealGroups: ["project-memory"],
      description: "These three links are the project memory. Start from what the repository already knows, then propose a change instead of editing knowledge in place.",
      features: [
        { title: "Context", detail: "Every Wiki record and how it connects, including the code it is grounded in.", icon: Network },
        { title: "Code", detail: "Symbols and source from the Graph, without silently refreshing the index.", icon: Code2 },
        { title: "Inbox", detail: "Propose an addition or correction to existing knowledge for team review.", icon: Inbox },
      ],
      primary: "Next",
      secondary: "Skip tour",
    },
    {
      id: "team",
      eyebrow: "Teamwork",
      title: "Hand work to people, not chat",
      icon: Send,
      targets: ["group-teamwork"],
      revealGroups: ["teamwork"],
      description: "Relays and Activity live here. They are durable records and survive the session that created them.",
      features: [
        { title: "Relays", detail: "Open a handoff for teammates, including people who are not active yet.", icon: Send },
        { title: "Activity", detail: "An immutable timeline of what happened, with current names shown separately.", icon: Activity },
        { title: "Team", detail: "Who belongs to this checkout, and who is acting in this Hub session.", icon: UsersRound },
      ],
      primary: "Next",
      secondary: "Skip tour",
    },
    {
      id: "search",
      eyebrow: "Search",
      title: "Find anything from here",
      icon: Search,
      targets: ["search"],
      description: "Search sits at the top of the sidebar. Press / from anywhere in the Hub to jump here and query project memory.",
      primary: "Next",
      secondary: "Skip tour",
    },
    {
      id: "system",
      eyebrow: "System",
      title: "Stay oriented",
      icon: HeartPulse,
      targets: ["group-system"],
      revealGroups: ["system"],
      description: "Health, Settings, and Jobs live under System at the bottom of the sidebar. They keep this checkout honest without leaving the machine.",
      features: [
        { title: "Health", detail: "See whether Graph and Wiki indexes are ready, stale, or need an explicit job.", icon: HeartPulse },
        { title: "Settings", detail: "Checkout preferences, including agent logging.", icon: Settings2 },
        { title: "Jobs", detail: "Watch explicit refresh and rebuild work after you start it.", icon: GitPullRequestArrow },
      ],
      primary: "Next",
      secondary: "Skip tour",
    },
    {
      id: "replay",
      eyebrow: "Settings",
      title: "Rewatch this tour anytime",
      icon: Settings2,
      targets: ["settings"],
      revealGroups: ["system"],
      description: "Open Settings — this link in System. The Hub tour section has Replay Hub tour. Completion is saved for this checkout, so each teammate still sees the walkthrough in their own.",
      primary: "Next",
      secondary: "Skip tour",
    },
    {
      id: "ready",
      eyebrow: "Ready",
      title: "You’re set",
      icon: Network,
      targets: ["knowledge"],
      revealGroups: ["project-memory"],
      description: "Context is the fastest way to see how this repository is connected. Open it now, or stay here and come back from the Project group.",
      primary: "Open Context",
      secondary: "Stay here",
      finishPath: "/knowledge",
    },
  ];
}
