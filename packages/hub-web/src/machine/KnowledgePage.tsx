import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Plus, Search } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { KnowledgeAddDialog } from "./KnowledgeAddDialog";
import { KnowledgeDate, KnowledgeDetailPanel, type KnowledgeItemAction } from "./KnowledgeDetail";
import { KnowledgeAreaGrid, KnowledgeGrouping, KnowledgeKindGrid } from "./KnowledgeGroups";
import { KnowledgeNeedsLook } from "./KnowledgeNeedsLook";
import { audienceLabels, kindLabels, scopeLabel } from "./knowledge-labels";
import { KnowledgeStatusLabel, knowledgeStatuses } from "./KnowledgeStatus";
import { fullDateTime, relativeTime } from "./local-time";
import type { ForgottenItem, KnowledgeFilters, KnowledgeItem, KnowledgePreview, KnowledgeStatusCounts } from "./types";
import styles from "./knowledge.module.css";
import shared from "./machine.module.css";

const number = new Intl.NumberFormat();
const filterNames = ["q", "kind", "audience", "status", "repo", "area"] as const;
type FilterName = typeof filterNames[number];

const narrowLayout = "(max-width: 1023px)";
function subscribeToLayout(listener: () => void) {
  const media = window.matchMedia(narrowLayout);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const isNarrow = () => window.matchMedia(narrowLayout).matches;

interface KnowledgePageProps {
  project?: MachineProject;
  projects: readonly MachineProject[];
  knowledge?: KnowledgePreview;
}

interface FilterOption {
  value: string;
  label: string;
  optionLabel?: string;
  display?: ReactNode;
}

const kindOptions = Object.entries(kindLabels).map(([value, label]) => ({ value, label }));
const audienceOptions = Object.entries(audienceLabels).map(([value, label]) => ({ value, label }));
const statusSymbols = { upToDate: "✓", codeChanged: "⚠", outOfDate: "⊗", notChecked: "◌" };
const needsLookFilter = "needs-look";
const statusOptions: readonly FilterOption[] = [
  ...knowledgeStatuses.map(({ key, slug, label }) => ({
    value: slug, label, optionLabel: `${statusSymbols[key]} ${label}`,
    display: <KnowledgeStatusLabel className={styles.status} status={key} />,
  })),
  { value: needsLookFilter, label: "Needs a look" },
];

function FilterMenu({ label, all, value, choices, onSelect }: {
  label: string;
  all: string;
  value?: string;
  choices: readonly FilterOption[];
  onSelect: (value: string) => void;
}) {
  const selected = choices.find((choice) => choice.value === value);
  return (
    <div className={styles.filter} data-active={Boolean(selected)}>
      <span aria-hidden="true">{selected?.display ?? selected?.label ?? label}</span>
      <NativeSelect aria-label={label} className={styles.filterSelect} onChange={(event) => onSelect(event.target.value)} value={selected?.value ?? ""}>
        <NativeSelectOption value="">{all}</NativeSelectOption>
        {choices.map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>{choice.optionLabel ?? choice.label}</NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

function KnowledgeSummary({ counts, total, active, browseHref, onToggle }: {
  counts: KnowledgeStatusCounts;
  total: number;
  active?: string;
  browseHref?: string;
  onToggle: (status: string) => void;
}) {
  const activeLegend = useRef<HTMLButtonElement>(null);
  return (
    <section aria-label="Knowledge status totals" className={styles.summary}>
      <div className={styles.summaryTop}>
        <p><strong>{number.format(total)}</strong> {total === 1 ? "item" : "items"}</p>
        {active && (
          <Button
            className={styles.clearStatus}
            onClick={() => {
              activeLegend.current?.focus();
              onToggle(active);
            }}
            size="sm"
            variant="link"
          >Clear<span className={shared.srOnly}> status filter</span></Button>
        )}
        {browseHref && total > 0 && (
          <Link className={shared.textLink} to={browseHref}>View all items <ArrowRight aria-hidden="true" /></Link>
        )}
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
            <button aria-pressed={active === slug} onClick={() => onToggle(slug)} ref={active === slug ? activeLegend : undefined} type="button">
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
  const age = used && relativeTime(used, now, true);
  const identityPrefix = [kindLabels[item.kind], repo].filter(Boolean).join(" · ");
  const audience = audienceLabels[item.audience];
  const compactAudience = item.audience === "hint" ? "Agent hint" : item.audience === "team" ? "Team" : audience;
  const status = knowledgeStatuses.find(({ key }) => key === item.status)!.label;
  const identity = `${identityPrefix} · ${audience}`;
  const accessibleLabel = `${item.oneLine}, ${identity} · ${status} · ${age ? `used ${age}` : "never used"}`;
  return (
    <li>
      <Link aria-current={active ? "page" : undefined} aria-label={accessibleLabel} className={styles.row} data-item-key={item.key} to={href}>
        <span className={styles.rowClaim} title={item.oneLine}>{item.oneLine}</span>
        <ChevronRight aria-hidden="true" className={styles.rowArrow} />
        <span className={styles.rowMeta}>
          <span className={styles.rowIdentity} title={identity}>
            {identityPrefix} · <span className={styles.fullAudience}>{audience}</span><span className={styles.compactAudience}>{compactAudience}</span>
          </span>
          <span aria-hidden="true">·</span>
          <KnowledgeStatusLabel className={styles.status} status={item.status} />
          <span aria-hidden="true">·</span>
          {used
            ? <span>used <time dateTime={item.lastUsedAt!} title={fullDateTime.format(used)}>{age}</time></span>
            : <span>never used</span>}
        </span>
      </Link>
    </li>
  );
}

function KnowledgeHeader({ scope, updating, titleRef, action }: {
  scope: string;
  updating?: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
  action?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.title}>
        <h1 className={shared.pageTitle} ref={titleRef} tabIndex={-1}>Knowledge</h1>
        <span title={scope}>· {scope}</span>
        {updating && <span className={styles.updating} role="status">Updating…</span>}
      </div>
      {action}
    </header>
  );
}

function ForgottenView({ items, repoNames, backHref, titleRef }: {
  items: readonly ForgottenItem[];
  repoNames: ReadonlyMap<string, string>;
  backHref: string;
  titleRef: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className={styles.page}>
      <Link className={`${shared.textLink} ${styles.back}`} to={backHref}><ArrowLeft aria-hidden="true" /> Knowledge</Link>
      <header className={styles.forgottenHeader}>
        <h1 className={shared.pageTitle} ref={titleRef} tabIndex={-1}>Forgotten</h1>
        <p className={shared.muted}>Forgotten items stay out of what MEX gives your agents. Their content isn’t shown here.</p>
      </header>
      {items.length ? (
        <div className={styles.listCard}>
          <table aria-label="Forgotten items" className={styles.forgottenTable}>
            <thead><tr><th scope="col">ID</th><th scope="col">Date forgotten</th><th scope="col">Repo</th><th scope="col">Who sees it</th></tr></thead>
            <tbody>
              {items.map(({ id, repoId, audience, at }) => (
                <tr key={`${repoId}:${audience}:${id}`}>
                  <th scope="row"><code>{id}</code></th>
                  <td><KnowledgeDate at={at} /></td>
                  <td>{repoNames.get(repoId) ?? "Unknown repo"}</td>
                  <td>{audienceLabels[audience]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className={`${styles.listCard} ${styles.emptyForgotten}`}>No forgotten items.</p>}
    </div>
  );
}

function KnowledgeBrowser({ project, projects, knowledge }: Omit<KnowledgePageProps, "knowledge"> & { knowledge: KnowledgePreview }) {
  const { entryKey } = useParams();
  const narrow = useSyncExternalStore(subscribeToLayout, isNarrow);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const basePath = project ? `/repos/${encodeURIComponent(project.id)}/knowledge` : "/knowledge";
  const linkTo = (path: string, query = params) => `${path}${query.size ? `?${query}` : ""}`;
  const listHref = linkTo(basePath);
  const landingParams = new URLSearchParams(params);
  filterNames.forEach((name) => landingParams.delete(name));
  landingParams.delete("view");
  const allKnowledgeHref = linkTo(basePath, landingParams);
  const browseParams = new URLSearchParams(landingParams);
  browseParams.set("view", "list");
  const browseHref = linkTo(basePath, browseParams);
  const showList = Boolean(entryKey || params.get("view") === "list" || filterNames.some((name) => params.get(name)?.trim()));
  const grouping = params.get("view") === "area" ? "area" : "kind";
  const q = params.get("q") ?? "";
  const [query, setQuery] = useState(q);
  const writtenQuery = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSession, setAddSession] = useState(0);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const [pendingAction, setPendingAction] = useState<{ key: string; action: KnowledgeItemAction }>();
  const initialAction = pendingAction && pendingAction.key === entryKey ? pendingAction.action : undefined;
  const statusParam = params.get("status");
  const activeStatus = knowledgeStatuses.find(({ slug }) => slug === statusParam);
  const statusFilter = statusParam === needsLookFilter ? needsLookFilter : activeStatus?.slug;
  const filters: KnowledgeFilters = {
    scopeId: project?.id,
    repoId: project ? undefined : projects.find(({ id }) => id === params.get("repo"))?.id,
    kind: kindOptions.find(({ value }) => value === params.get("kind"))?.value as KnowledgeFilters["kind"],
    audience: audienceOptions.find(({ value }) => value === params.get("audience"))?.value as KnowledgeFilters["audience"],
    status: statusFilter === needsLookFilter ? needsLookFilter : activeStatus?.key,
    area: params.get("area") || undefined,
    query: q,
  };
  const landing = !showList ? knowledge.getLanding(project?.id) : undefined;
  const areaOptions = filters.area ? [...new Set([
    ...knowledge.getLanding(project?.id ?? filters.repoId).groups.byArea.map(({ pattern }) => pattern),
    filters.area,
  ])].map((value) => ({ value, label: scopeLabel([value]) })) : [];
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
  const forgotten = knowledge.forgotten.filter(({ repoId }) => !project || repoId === project.id);
  const isForgotten = entryKey === "forgotten";
  const found = entryKey && !isForgotten ? knowledge.getDetail(entryKey) : undefined;
  const detail = !project || found?.repoId === project.id ? found : undefined;
  const title = useRef<HTMLHeadingElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousKey = useRef<string | undefined>(undefined);
  const previousList = useRef(showList);
  const firstNewRow = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (entryKey && entryKey !== previousKey.current) {
      if (narrow || !previousList.current) document.scrollingElement?.scrollTo(0, 0);
      if (initialAction) setPendingAction(undefined);
      else detailTitle.current?.focus({ preventScroll: true });
    } else if (!entryKey && !browser.current?.contains(document.activeElement)) {
      const row = Array.from(browser.current?.querySelectorAll<HTMLAnchorElement>("[data-item-key]") ?? [])
        .find((link) => link.dataset.itemKey === previousKey.current);
      (row ?? title.current)?.focus();
    }
    previousKey.current = entryKey;
    previousList.current = showList;
  }, [entryKey, initialAction, showList]);

  useLayoutEffect(() => {
    if (firstNewRow.current !== null) {
      browser.current?.querySelectorAll<HTMLAnchorElement>("[data-item-key]")[firstNewRow.current]?.focus();
      firstNewRow.current = null;
    }
  }, [items.length]);

  useEffect(() => {
    if (writtenQuery.current !== q) setQuery(q);
    writtenQuery.current = null;
  }, [q]);
  useEffect(() => {
    const search = query.trim();
    if (search === q || isForgotten) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search) next.set("q", search);
      else next.delete("q");
      writtenQuery.current = search;
      navigate({ pathname: basePath, search: next.toString() }, { replace: true });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [basePath, isForgotten, navigate, params, q, query]);

  function changeFilter(name: FilterName, value: string) {
    const next = new URLSearchParams(params);
    const search = query.trim();
    if (search) next.set("q", search);
    else next.delete("q");
    if (value) next.set(name, value);
    else next.delete(name);
    if (!filterNames.some((filter) => next.has(filter))) next.set("view", "list");
    navigate(linkTo(basePath, next));
  }

  function clearFilters() {
    setQuery("");
    searchInput.current?.focus();
    navigate(browseHref);
  }

  function itemHref(item: KnowledgeItem, query = params) {
    return linkTo(`${basePath}/${encodeURIComponent(item.key)}`, query);
  }

  const needsLookParams = new URLSearchParams(params);
  needsLookParams.set("status", needsLookFilter);

  function startAdd(event: MouseEvent<HTMLButtonElement>) {
    addTrigger.current = event.currentTarget;
    setAddSession((session) => session + 1);
    setAddOpen(true);
  }

  if (isForgotten) return <ForgottenView backHref={listHref} items={forgotten} repoNames={repoNames} titleRef={detailTitle} />;

  return (
    <div className={styles.page} data-detail={Boolean(entryKey)} ref={browser}>
      <div className={styles.overview}>
        <KnowledgeHeader
          action={<Button aria-haspopup="dialog" className={styles.addButton} onClick={startAdd} type="button"><Plus aria-hidden="true" /> Add a note</Button>}
          scope={project?.name ?? "All repos"}
          titleRef={title}
          updating={first.updatingSince}
        />
        <KnowledgeSummary
          active={statusFilter}
          browseHref={showList ? undefined : browseHref}
          counts={first.statusCounts}
          onToggle={(slug) => changeFilter("status", statusFilter === slug ? "" : slug)}
          total={total}
        />
        {landing && (
          <KnowledgeNeedsLook
            itemHref={(item) => itemHref(item, needsLookParams)}
            listHref={linkTo(basePath, needsLookParams)}
            onAction={(item, action) => {
              setPendingAction({ key: item.key, action });
              navigate(itemHref(item, needsLookParams));
            }}
            repoNames={project ? undefined : repoNames}
            summary={landing.needsLook}
          />
        )}
        <div className={styles.toolbar} data-landing={!showList}>
          <div className={styles.search}>
            <Search aria-hidden="true" />
            <Input aria-label="Search knowledge" onChange={(event) => setQuery(event.target.value)} placeholder="Search knowledge…" ref={searchInput} type="search" value={query} />
          </div>
          {showList ? <div className={styles.filters}>
            <FilterMenu all="All kinds" choices={kindOptions} label="Kind" onSelect={(value) => changeFilter("kind", value)} value={filters.kind} />
            <FilterMenu all="Everyone" choices={audienceOptions} label="Who sees it" onSelect={(value) => changeFilter("audience", value)} value={filters.audience} />
            <FilterMenu all="All statuses" choices={statusOptions} label="Status" onSelect={(value) => changeFilter("status", value)} value={statusFilter} />
            {!project && (
              <FilterMenu all="All repos" choices={projects.map(({ id, name }) => ({ value: id, label: name }))} label="Repo" onSelect={(value) => changeFilter("repo", value)} value={filters.repoId} />
            )}
            {filters.area && (
              <FilterMenu all="All areas" choices={areaOptions} label="Area" onSelect={(value) => changeFilter("area", value)} value={filters.area} />
            )}
          </div> : <KnowledgeGrouping onChange={(value) => {
            const next = new URLSearchParams(params);
            if (value === "area") next.set("view", value);
            else next.delete("view");
            navigate(linkTo(basePath, next));
          }} value={grouping} />}
          <Link className={`${shared.textLink} ${styles.forgottenLink}`} to={linkTo(`${basePath}/forgotten`)}>
            Forgotten ({number.format(forgotten.length)})
          </Link>
        </div>
        {showList && (
          <Link className={`${shared.textLink} ${styles.back}`} to={allKnowledgeHref}><ArrowLeft aria-hidden="true" /> All knowledge</Link>
        )}
        <span className={shared.srOnly} role="status">{notice}</span>
      </div>
      {landing?.groups.byKind.length ? (
        grouping === "area" ? <KnowledgeAreaGrid
          groups={landing.groups.byArea}
          href={({ pattern, repoId }, item) => {
            const next = new URLSearchParams(params);
            next.set("area", pattern);
            if (!project && repoId) next.set("repo", repoId);
            return item ? itemHref(item, next) : linkTo(basePath, next);
          }}
          repoNames={project ? undefined : repoNames}
          total={total}
        /> : <KnowledgeKindGrid groups={landing.groups.byKind} href={(kind, item) => {
          const next = new URLSearchParams(params);
          next.set("kind", kind);
          return item ? itemHref(item, next) : linkTo(basePath, next);
        }} />
      ) : <div className={styles.workspace}>
        {items.length > 0 ? (
          <section aria-label="Knowledge items" className={styles.listCard}>
            <ul aria-label="Items" className={styles.rows} role="list">
              {items.map((item) => (
                <KnowledgeRow
                  active={item.key === entryKey}
                  href={itemHref(item)}
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
                  onClick={() => {
                    firstNewRow.current = items.length;
                    setPaging({ filterKey, pageCount: paging.filterKey === filterKey ? paging.pageCount + 1 : 2 });
                  }}
                  size="sm"
                  variant="outline"
                >Load more</Button>
              )}
            </div>
          </section>
        ) : (
          <section aria-label="Knowledge items" className={`${styles.listCard} ${styles.empty}`}>
            {total === 0 ? (
              <>
                <BookOpen aria-hidden="true" />
                <p>Nothing learned yet. Add a note, or let MEX learn from your sessions.</p>
                <Button aria-haspopup="dialog" onClick={startAdd} size="sm" type="button" variant="outline">Add a note</Button>
              </>
            ) : (
              <><Search aria-hidden="true" /><p role="status">No items match these filters.</p><Button onClick={clearFilters} size="sm" variant="outline">Clear filters</Button></>
            )}
          </section>
        )}
        {entryKey ? (
          <KnowledgeDetailPanel
            backHref={listHref}
            initialAction={initialAction}
            item={detail}
            key={entryKey}
            knowledge={knowledge}
            narrow={narrow}
            now={now}
            onForgotten={() => {
              setNotice("Item moved to Forgotten.");
              navigate(listHref, { replace: true });
            }}
            titleRef={detailTitle}
          />
        ) : items.length > 0 && (
          <div className={styles.detailPlaceholder}><BookOpen aria-hidden="true" /><p>Select an item to read it.</p></div>
        )}
      </div>}
      <KnowledgeAddDialog
        finalFocus={() => addTrigger.current?.isConnected ? addTrigger.current : false}
        key={addSession}
        onClose={() => setAddOpen(false)}
        onSave={(request) => {
          const { item } = knowledge.createNote(request);
          setQuery("");
          addTrigger.current = null;
          setAddOpen(false);
          navigate(itemHref(item, showList ? browseParams : params));
        }}
        open={addOpen}
        preferredRepo={filters.repoId}
        project={project}
        projects={projects}
      />
    </div>
  );
}

export default function KnowledgePage({ project, projects, knowledge }: KnowledgePageProps) {
  const unavailableTitle = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { unavailableTitle.current?.focus({ preventScroll: true }); }, []);
  if (!knowledge) return (
    <div className={styles.page}>
      <KnowledgeHeader scope={project?.name ?? "All repos"} titleRef={unavailableTitle} />
      <p className={shared.muted}>Knowledge isn’t available yet.</p>
    </div>
  );
  return <KnowledgeBrowser knowledge={knowledge} project={project} projects={projects} />;
}
