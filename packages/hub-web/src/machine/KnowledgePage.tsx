import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "../components/primitives/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "../components/primitives/dropdown-menu";
import { Input } from "../components/primitives/input";
import { audienceLabels, kindLabels } from "./knowledge-labels";
import { KnowledgeStatusLabel, knowledgeStatuses } from "./KnowledgeStatus";
import { fullDateTime, relativeTime } from "./local-time";
import type { KnowledgeFilters, KnowledgeItem, KnowledgePreview, KnowledgeStatusCounts } from "./types";
import styles from "./knowledge.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();
const filterNames = ["q", "kind", "audience", "status", "repo"] as const;
type FilterName = typeof filterNames[number];

interface KnowledgePageProps {
  project?: MachineProject;
  projects: readonly MachineProject[];
  knowledge?: KnowledgePreview;
}

interface FilterOption {
  value: string;
  label: string;
  display?: ReactNode;
}

const kindOptions = Object.entries(kindLabels).map(([value, label]) => ({ value, label }));
const audienceOptions = Object.entries(audienceLabels).map(([value, label]) => ({ value, label }));
const statusOptions = knowledgeStatuses.map(({ key, slug, label }) => ({
  value: slug, label, display: <KnowledgeStatusLabel className={styles.status} status={key} />,
}));

function FilterMenu({ label, all, value, choices, onSelect }: {
  label: string;
  all: string;
  value?: string;
  choices: readonly FilterOption[];
  onSelect: (value: string) => void;
}) {
  const selected = choices.find((choice) => choice.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={selected ? `${label}: ${selected.label}` : label}
        render={<Button className={styles.filter} data-active={Boolean(selected)} variant="outline" />}
      >
        <span>{selected?.display ?? selected?.label ?? label}</span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={label} className={styles.filterMenu}>
        {[{ value: "", label: all }, ...choices].map((choice) => {
          const checked = (selected?.value ?? "") === choice.value;
          return (
            <DropdownMenuItem
              aria-checked={checked}
              className={styles.filterOption}
              key={choice.value}
              onClick={() => onSelect(choice.value)}
              role="menuitemradio"
            >
              {choice.display ?? choice.label}
              {checked && <Check aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KnowledgeSummary({ counts, total, active, onToggle }: {
  counts: KnowledgeStatusCounts;
  total: number;
  active?: string;
  onToggle: (status: string) => void;
}) {
  return (
    <section aria-label="Knowledge status totals" className={styles.summary}>
      <div className={styles.summaryTop}>
        <p><strong>{number.format(total)}</strong> {total === 1 ? "item" : "items"}</p>
        {active && <Button className={styles.clearStatus} onClick={() => onToggle(active)} size="sm" variant="link">Clear<span className={shared.srOnly}> status filter</span></Button>}
      </div>
      <div aria-label="Filter by knowledge status" className={styles.segmentBar} role="group">
        {knowledgeStatuses.map(({ key, slug, label, color }) => counts[key] > 0 && (
          <button
            aria-label={`Filter by ${label.toLowerCase()} (${number.format(counts[key])} items)`}
            aria-pressed={active === slug}
            className={styles.segment}
            key={key}
            onClick={() => onToggle(slug)}
            style={{ flexGrow: counts[key], background: color }}
            type="button"
          />
        ))}
      </div>
      <ul aria-label="Status legend" className={styles.legend} role="list">
        {knowledgeStatuses.map(({ key, slug }) => (
          <li key={key}>
            <button aria-pressed={active === slug} onClick={() => onToggle(slug)} type="button">
              <KnowledgeStatusLabel className={styles.status} status={key} />
              <strong>{number.format(counts[key])}</strong>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KnowledgeRow({ item, href, repo, active, now }: {
  item: KnowledgeItem;
  href: string;
  repo?: string;
  active: boolean;
  now: Date;
}) {
  const used = item.lastUsedAt && new Date(item.lastUsedAt);
  const identity = [kindLabels[item.kind], repo, audienceLabels[item.audience]].filter(Boolean).join(" · ");
  return (
    <li>
      <Link aria-current={active ? "page" : undefined} className={styles.row} data-item-key={item.key} to={href}>
        <span className={styles.rowClaim} title={item.oneLine}>{item.oneLine}</span>
        <ChevronRight aria-hidden="true" className={styles.rowArrow} />
        <span className={styles.rowMeta}>
          <span className={styles.rowIdentity} title={identity}>{identity}</span>
          <span aria-hidden="true">·</span>
          <KnowledgeStatusLabel className={styles.status} status={item.status} />
          <span aria-hidden="true">·</span>
          {used
            ? <span>used <time dateTime={item.lastUsedAt!} title={fullDateTime.format(used)}>{relativeTime(used, now)}</time></span>
            : <span>never used</span>}
        </span>
      </Link>
    </li>
  );
}

function KnowledgeHeader({ scope, updating, titleRef }: {
  scope: string;
  updating?: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.title}>
        <h1 className={shared.pageTitle} ref={titleRef} tabIndex={-1}>Knowledge</h1>
        <span title={scope}>· {scope}</span>
        {updating && <span className={styles.updating} role="status">Updating…</span>}
      </div>
    </header>
  );
}

function KnowledgeBrowser({ project, projects, knowledge }: Omit<KnowledgePageProps, "knowledge"> & { knowledge: KnowledgePreview }) {
  const { entryKey } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const basePath = project ? `/repos/${encodeURIComponent(project.id)}/knowledge` : "/knowledge";
  const linkTo = (path: string, query = params) => `${path}${query.size ? `?${query}` : ""}`;
  const listHref = linkTo(basePath);
  const q = params.get("q") ?? "";
  const [query, setQuery] = useState(q);
  const activeStatus = knowledgeStatuses.find(({ slug }) => slug === params.get("status"));
  const filters: KnowledgeFilters = {
    scopeId: project?.id,
    repoId: project ? undefined : projects.find(({ id }) => id === params.get("repo"))?.id,
    kind: kindOptions.find(({ value }) => value === params.get("kind"))?.value as KnowledgeFilters["kind"],
    audience: audienceOptions.find(({ value }) => value === params.get("audience"))?.value as KnowledgeFilters["audience"],
    status: activeStatus?.key,
    query: q,
  };
  const filterKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ filterKey, pageCount: 1 });
  const first = knowledge.getPage(filters);
  let page = first;
  const items = [...first.items];
  for (let n = 1; paging.filterKey === filterKey && n < paging.pageCount && page.nextCursor; n++) {
    page = knowledge.getPage(filters, page.nextCursor);
    items.push(...page.items);
  }

  const total = Object.values(first.statusCounts).reduce((sum, count) => sum + count, 0);
  const repoNames = new Map(projects.map(({ id, name }) => [id, name]));
  const now = new Date();
  const found = entryKey ? knowledge.getDetail(entryKey) : undefined;
  const detail = !project || found?.repoId === project.id ? found : undefined;
  const title = useRef<HTMLHeadingElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const previousKey = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (entryKey) {
      if (window.matchMedia("(max-width: 1023px)").matches) window.scrollTo(0, 0);
      detailTitle.current?.focus({ preventScroll: true });
    } else if (!browser.current?.contains(document.activeElement)) {
      const row = Array.from(browser.current?.querySelectorAll<HTMLAnchorElement>("[data-item-key]") ?? [])
        .find((link) => link.dataset.itemKey === previousKey.current);
      (row ?? title.current)?.focus();
    }
    previousKey.current = entryKey;
  }, [entryKey]);

  useEffect(() => setQuery(q), [q]);
  useEffect(() => {
    const search = query.trim();
    if (search === q) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search) next.set("q", search);
      else next.delete("q");
      navigate({ pathname: basePath, search: next.toString() }, { replace: true });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [basePath, navigate, params, q, query]);

  function changeFilter(name: FilterName, value: string) {
    const next = new URLSearchParams(params);
    const search = query.trim();
    if (search) next.set("q", search);
    else next.delete("q");
    if (value) next.set(name, value);
    else next.delete(name);
    navigate(linkTo(basePath, next));
  }

  function clearFilters() {
    const next = new URLSearchParams(params);
    filterNames.forEach((name) => next.delete(name));
    setQuery("");
    navigate(linkTo(basePath, next));
  }

  return (
    <div className={styles.page} data-detail={Boolean(entryKey)} ref={browser}>
      <div className={styles.overview}>
        <KnowledgeHeader scope={project?.name ?? "All repos"} titleRef={title} updating={first.updatingSince} />
        <KnowledgeSummary
          active={activeStatus?.slug}
          counts={first.statusCounts}
          onToggle={(slug) => changeFilter("status", activeStatus?.slug === slug ? "" : slug)}
          total={total}
        />
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Search aria-hidden="true" />
            <Input aria-label="Search knowledge" onChange={(event) => setQuery(event.target.value)} placeholder="Search knowledge…" type="search" value={query} />
          </div>
          <div className={styles.filters}>
            <FilterMenu all="All kinds" choices={kindOptions} label="Kind" onSelect={(value) => changeFilter("kind", value)} value={filters.kind} />
            <FilterMenu all="Everyone" choices={audienceOptions} label="Who sees it" onSelect={(value) => changeFilter("audience", value)} value={filters.audience} />
            <FilterMenu all="All statuses" choices={statusOptions} label="Status" onSelect={(value) => changeFilter("status", value)} value={activeStatus?.slug} />
            {!project && (
              <FilterMenu all="All repos" choices={projects.map(({ id, name }) => ({ value: id, label: name }))} label="Repo" onSelect={(value) => changeFilter("repo", value)} value={filters.repoId} />
            )}
          </div>
        </div>
      </div>
      <div className={styles.workspace}>
        {items.length > 0 ? (
          <section aria-label="Knowledge items" className={styles.listCard}>
            <ul aria-label="Items" className={styles.rows} role="list">
              {items.map((item) => (
                <KnowledgeRow
                  active={item.key === entryKey}
                  href={linkTo(`${basePath}/${encodeURIComponent(item.key)}`)}
                  item={item}
                  key={item.key}
                  now={now}
                  repo={project ? undefined : repoNames.get(item.repoId) ?? "Unknown repo"}
                />
              ))}
            </ul>
            <div className={styles.paging}>
              <p role="status">Showing {number.format(items.length)} of {number.format(first.total)}</p>
              {page.nextCursor && (
                <Button
                  onClick={() => setPaging({ filterKey, pageCount: paging.filterKey === filterKey ? paging.pageCount + 1 : 2 })}
                  size="sm"
                  variant="outline"
                >Load more</Button>
              )}
            </div>
          </section>
        ) : (
          <section aria-label="Knowledge items" className={`${styles.listCard} ${styles.empty}`}>
            {total === 0 ? (
              <><BookOpen aria-hidden="true" /><p>Nothing learned yet. Add a note, or let MEX learn from your sessions.</p></>
            ) : (
              <><Search aria-hidden="true" /><p role="status">No items match these filters.</p><Button onClick={clearFilters} size="sm" variant="outline">Clear filters</Button></>
            )}
          </section>
        )}
        {entryKey ? (
          <div className={styles.detailColumn}>
            <Link className={`${shared.textLink} ${styles.back}`} to={listHref}><ArrowLeft aria-hidden="true" /> Knowledge</Link>
            <section aria-labelledby="knowledge-item-title" className={styles.detailCard}>
              <div className={styles.detailHeader}>
                <h2 id="knowledge-item-title" ref={detailTitle} tabIndex={-1}>{detail?.oneLine ?? "Item unavailable"}</h2>
                <Button aria-label="Close item" className={styles.closeItem} render={<Link to={listHref} />} nativeButton={false} size="icon-sm" variant="ghost">
                  <X aria-hidden="true" />
                </Button>
              </div>
              <p className={styles.detailText}>{detail?.text ?? "This item may have been forgotten or moved to another repo."}</p>
            </section>
          </div>
        ) : total > 0 && (
          <div className={styles.detailPlaceholder}><BookOpen aria-hidden="true" /><p>Select an item to read it.</p></div>
        )}
      </div>
    </div>
  );
}

export default function KnowledgePage({ project, projects, knowledge }: KnowledgePageProps) {
  if (!knowledge) return (
    <div className={styles.page}>
      <KnowledgeHeader scope={project?.name ?? "All repos"} />
      <p className={shared.muted}>Knowledge isn’t available yet.</p>
    </div>
  );
  return <KnowledgeBrowser knowledge={knowledge} project={project} projects={projects} />;
}
