import { useId } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { knowledgeStatuses } from "./KnowledgeStatus";
import { kindLabels, scopeLabel } from "./knowledge-labels";
import type { KnowledgeItem, KnowledgeKind, KnowledgeLandingData, KnowledgeStatusCounts } from "./types";
import styles from "./knowledge-landing.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();
type AreaGroup = KnowledgeLandingData["groups"]["byArea"][number];
type Grouping = "kind" | "area";

const kindCopy = {
  rule: { title: "Rules", description: "What to do and what to avoid" },
  decision: { title: "Decisions", description: "Choices made and why" },
  recipe: { title: "Recipes", description: "How to do common tasks" },
  pitfall: { title: "Pitfalls", description: "Mistakes to avoid" },
  procedure: { title: "Procedures", description: "Step-by-step processes" },
  fact: { title: "Facts", description: "How things work here" },
  hint: { title: "Hints from your agent", description: "Seen in your agent’s memory" },
} satisfies Record<KnowledgeKind, { title: string; description: string }>;

function GroupStatus({ counts }: { counts: KnowledgeStatusCounts }) {
  const breakdown = knowledgeStatuses.map(({ key, label }) => `${number.format(counts[key])} ${label.toLowerCase()}`).join(", ");
  const present = knowledgeStatuses.filter(({ key }) => counts[key] > 0);
  return (
    <div aria-label={breakdown} className={styles.groupStatus} role="img" title={breakdown}>
      <div aria-hidden="true" className={styles.statusBar}>
        {present.map(({ key, color }) => <span key={key} style={{ background: color, flexGrow: counts[key] }} />)}
      </div>
      <div aria-hidden="true" className={styles.statusCounts}>
        {present.map(({ key, Icon }) => (
          <span key={key}><Icon aria-hidden="true" /> {number.format(counts[key])}</span>
        ))}
      </div>
    </div>
  );
}

function GroupCard({ title, description, count, statusCounts, topItems, listHref, itemHref, showKind }: {
  title: string;
  description?: string;
  count: number;
  statusCounts: KnowledgeStatusCounts;
  topItems: readonly KnowledgeItem[];
  listHref: string;
  itemHref: (item: KnowledgeItem) => string;
  showKind?: boolean;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className={styles.card}>
      <div className={styles.cardHeading}>
        <h2 id={heading} title={title}>{title}</h2>
        <span>{number.format(count)}<span className={shared.srOnly}> {count === 1 ? "item" : "items"}</span></span>
      </div>
      {description && <p className={styles.description}>{description}</p>}
      <GroupStatus counts={statusCounts} />
      <ul aria-label={`Recent items in ${title}`} className={styles.groupItems} role="list">
        {topItems.map((item) => (
          <li key={item.key}>
            <Link className={styles.groupItem} data-item-key={item.key} to={itemHref(item)}>
              <span title={item.oneLine}>{item.oneLine}</span>
              {showKind && <span className={styles.groupKind}>{kindLabels[item.kind]}</span>}
            </Link>
          </li>
        ))}
      </ul>
      <Link className={`${shared.textLink} ${styles.groupMore}`} to={listHref}>
        See all {number.format(count)} <ArrowRight aria-hidden="true" /><span className={shared.srOnly}> in {title}</span>
      </Link>
    </section>
  );
}

export function KnowledgeAreaGrid({ groups, total, href, repoNames }: {
  groups: readonly AreaGroup[];
  total: number;
  href: (group: AreaGroup, item?: KnowledgeItem) => string;
  repoNames?: ReadonlyMap<string, string>;
}) {
  const wholeRepo = groups.find(({ pattern }) => pattern === "**");
  return (
    <>
      <div className={styles.grid}>
        {groups.map((group) => {
          const area = scopeLabel([group.pattern]);
          const repo = group.repoId && repoNames ? repoNames.get(group.repoId) ?? "Unknown repo" : undefined;
          const title = repo ? `${repo} · ${area}` : area;
          return (
            <GroupCard
              {...group}
              itemHref={(item) => href(group, item)}
              key={JSON.stringify([group.repoId, group.pattern])}
              listHref={href(group)}
              showKind
              title={title}
            />
          );
        })}
      </div>
      {wholeRepo && wholeRepo.count / total > 0.6 && (
        <p className={styles.areaFootnote}>Most items apply to the whole repo. Areas fill in as MEX learns about specific parts of your code.</p>
      )}
    </>
  );
}

export function KnowledgeGrouping({ value, onChange }: { value: Grouping; onChange: (value: Grouping) => void }) {
  const name = useId();
  return (
    <div aria-label="Group knowledge by" className={styles.grouping} role="radiogroup">
      {(["kind", "area"] as const).map((grouping) => (
        <label key={grouping}>
          <input
            checked={value === grouping}
            className={shared.srOnly}
            name={name}
            onChange={() => onChange(grouping)}
            type="radio"
            value={grouping}
          />
          <span>By {grouping}</span>
        </label>
      ))}
    </div>
  );
}

export function KnowledgeKindGrid({ groups, href }: {
  groups: KnowledgeLandingData["groups"]["byKind"];
  href: (kind: KnowledgeKind, item?: KnowledgeItem) => string;
}) {
  return (
    <div className={styles.grid}>
      {groups.map(({ kind, ...group }) => (
        <GroupCard {...group} {...kindCopy[kind]} itemHref={(item) => href(kind, item)} key={kind} listHref={href(kind)} />
      ))}
    </div>
  );
}
