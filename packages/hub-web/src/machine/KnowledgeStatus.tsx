import { Check, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import type { KnowledgeStatus } from "./types";
import shared from "./machine.module.css";

export const knowledgeStatuses = [
  { key: "upToDate", slug: "up-to-date", label: "Up to date", color: "var(--chart-up-to-date)", Icon: Check },
  { key: "codeChanged", slug: "code-changed", label: "Code changed", color: "var(--chart-code-changed)", Icon: TriangleAlert },
  { key: "outOfDate", slug: "out-of-date", label: "Out of date", color: "var(--chart-out-of-date)", Icon: CircleX },
  { key: "notChecked", slug: "not-checked", label: "Not checked", color: "var(--chart-not-checked)", Icon: CircleDashed },
] as const;

export function KnowledgeStatusLabel({ status, className, iconOnly }: { status: KnowledgeStatus; className?: string; iconOnly?: boolean }) {
  const { Icon, label } = knowledgeStatuses.find(({ key }) => key === status)!;
  return <span className={className} data-knowledge-status={status}><Icon aria-hidden="true" />{iconOnly ? <span className={shared.srOnly}>{label}</span> : label}</span>;
}
