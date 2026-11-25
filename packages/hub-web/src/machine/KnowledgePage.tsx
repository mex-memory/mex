import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Plus, Search } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "../components/primitives/button";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { HubProblemError } from "./api";
import type { HubEventState } from "./data";
import { useForgotten, useKnowledgeActions, useKnowledgeItem, useKnowledgeLanding, useKnowledgePage } from "./knowledge-data";
import { KnowledgeAddDialog } from "./KnowledgeAddDialog";
import { KnowledgeBrief } from "./KnowledgeBrief";
import { KnowledgeDate, KnowledgeDetailPanel, type KnowledgeItemAction } from "./KnowledgeDetail";
import { KnowledgeAreaGrid, KnowledgeGrouping, KnowledgeKindGrid } from "./KnowledgeGroups";
import { KnowledgeNeedsLook } from "./KnowledgeNeedsLook";
import { KnowledgeRules } from "./KnowledgeRules";
import { audienceLabels, kindLabels, scopeLabel } from "./knowledge-labels";
import { KnowledgeStatusLabel, knowledgeStatuses } from "./KnowledgeStatus";
import { fullDateTime, relativeTime } from "./local-time";
import type { ForgottenItem, KnowledgeActions, KnowledgeDetail, KnowledgeFilters, KnowledgeItem, KnowledgeLandingData, KnowledgePreview, KnowledgeStatusCounts } from "./types";
import type { PageLoad } from "./ui";
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

interface KnowledgeScope {
  project?: MachineProject;
  projects: readonly MachineProject[];
}

export interface KnowledgeConnection {
  events: HubEventState;
  csrfToken: string;
  reportDataError: (error: unknown) => void;
}

type KnowledgePageProps = KnowledgeScope & ({ knowledge: KnowledgePreview; live?: undefined } | {
  knowledge?: undefined;
  live: KnowledgeConnection;
});

interface KnowledgeView {
  items: KnowledgeItem[];
  total: number;
  counts: KnowledgeStatusCounts;
  updating?: string;
  partial?: KnowledgeLandingData["partial"];
  landing?: KnowledgeLandingData;
  areas: KnowledgeLandingData["groups"]["byArea"];
  detail?: KnowledgeDetail;
  detailMissing?: boolean;
  detailLoad?: PageLoad;
  forgotten: readonly ForgottenItem[];
  forgottenCount?: number;
  load?: PageLoad;
  loadMore?: () => void;
  fetching?: boolean;
}

const emptyCounts = (): KnowledgeStatusCounts => ({ upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0 });

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
  const focusAfterClear = active === needsLookFilter ? "out-of-date" : active;
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
            <button aria-pressed={active === slug} onClick={() => onToggle(slug)} ref={focusAfterClear === slug ? activeLegend : undefined} type="button">
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
  const noUse = item.useCount30Days === undefined ? "never used" : "no recent use";
  const accessibleLabel = `${item.oneLine}, ${identity} · ${status} · ${age ? `used ${age}` : noUse}`;
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
            : <span>{noUse}</span>}
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

function KnowledgeLoad({ load, label }: { load: PageLoad; label: string }) {
  if (load.loading) return <p className={shared.pageState} role="status">Loading {label}…</p>;
  if (!load.error) return null;
  return <div className={shared.pageState}>
    <p role="status">Couldn’t load {label}.</p>
    <Button onClick={load.retry} size="sm" type="button" variant="outline">Retry</Button>
  </div>;
}

function KnowledgePartial({ partial, repoNames }: { partial: KnowledgeView["partial"]; repoNames: ReadonlyMap<string, string> }) {
  if (!partial?.length) return null;
  return <div role="status" className={shared.muted}>
    {partial.map(({ repoId, note }) => <p key={(repoId ?? "") + note}>{repoId && repoNames.has(repoId) && `${repoNames.get(repoId)} · `}{note}</p>)}
  </div>;
}

function ForgottenView({ items, repoNames, backHref, titleRef, load, loadMore, fetching, partial }: {
  items: readonly ForgottenItem[];
  repoNames: ReadonlyMap<string, string>;
  backHref: string;
  titleRef: React.Ref<HTMLHeadingElement>;
  load?: PageLoad;
  loadMore?: () => void;
  fetching?: boolean;
  partial?: KnowledgeView["partial"];
}) {
  const { hash } = useLocation();
  const table = useRef<HTMLTableElement>(null);
  const focused = useRef("");
  useEffect(() => {
    if (hash === focused.current) return;
    const row = Array.from(table.current?.tBodies[0]?.rows ?? []).find(({ id }) => "#" + encodeURIComponent(id) === hash);
    if (row) {
      row.focus();
      focused.current = hash;
    } else {
      focused.current = "";
    }
  }, [hash, items]);

  return (
    <div className={styles.page}>
      <Link className={`${shared.textLink} ${styles.back}`} to={backHref}><ArrowLeft aria-hidden="true" /> Knowledge</Link>
      <header className={styles.forgottenHeader}>
        <h1 className={shared.pageTitle} ref={titleRef} tabIndex={-1}>Forgotten</h1>
        <p className={shared.muted}>Forgotten items stay out of what MEX gives your agents. Their content isn’t shown here.</p>
      </header>
      {load && <KnowledgeLoad label="forgotten items" load={load} />}
      <KnowledgePartial partial={partial} repoNames={repoNames} />
      {items.length ? (
        <div className={styles.listCard}>
          <table aria-label="Forgotten items" className={styles.forgottenTable} ref={table}>
            <thead><tr><th scope="col">ID</th><th scope="col">Date forgotten</th><th scope="col">Repo</th><th scope="col">Who sees it</th></tr></thead>
            <tbody>
              {items.map(({ id, repoId, audience, at }) => (
              <tr id={`${repoId}:${audience}:${id}`} key={`${repoId}:${audience}:${id}`} tabIndex={-1}>
                  <th scope="row"><code>{id}</code></th>
                  <td><KnowledgeDate at={at} /></td>
                  <td>{repoNames.get(repoId) ?? "Unknown repo"}</td>
                  <td>{audienceLabels[audience]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !load?.loading && !load?.error && <p className={`${styles.listCard} ${styles.emptyForgotten}`}>No forgotten items.</p>}
      {loadMore && (
        <div className={styles.paging}>
          <Button disabled={fetching} onClick={loadMore} size="sm" type="button" variant="outline">Load more</Button>
        </div>
      )}
    </div>
  );
}

function useKnowledgeRoute({ project, projects }: KnowledgeScope) {
  const entryKey = useParams().entryKey?.replace(":personal:", ":onlyYou:");
  const [params] = useSearchParams();
  const showList = Boolean(entryKey || params.get("view") === "list" || filterNames.some((name) => params.get(name)?.trim()));
  const statusParam = params.get("status");
  const activeStatus = knowledgeStatuses.find(({ slug }) => slug === statusParam);
  const statusFilter = statusParam === needsLookFilter ? needsLookFilter : activeStatus?.slug;
  const audience = params.get("audience");
  const q = params.get("q") ?? "";
  const filters: KnowledgeFilters = {
    scopeId: project?.id,
    repoId: project ? undefined : projects.find(({ id }) => id === params.get("repo"))?.id,
    kind: kindOptions.find(({ value }) => value === params.get("kind"))?.value as KnowledgeFilters["kind"],
    audience: audienceOptions.find(({ value }) => value === (audience === "personal" ? "onlyYou" : audience))?.value as KnowledgeFilters["audience"],
    status: statusFilter === needsLookFilter ? needsLookFilter : activeStatus?.key,
    area: params.get("area") || undefined,
    query: q.slice(0, 256),
  };
  return { entryKey, params, showList, statusFilter, filters, q };
}

type KnowledgeRoute = ReturnType<typeof useKnowledgeRoute>;

function KnowledgeBrowser({ project, projects, route, view, knowledge, live }: KnowledgeScope & {
  route: KnowledgeRoute;
  view: KnowledgeView;
  knowledge: KnowledgeActions | KnowledgePreview;
  live?: boolean;
}) {
  const { entryKey, params, showList, filters, statusFilter, q } = route;
  const { items, landing, detail, forgotten, load, detailLoad } = view;
  const tools = "tools" in knowledge ? knowledge.tools : undefined;
  const narrow = useSyncExternalStore(subscribeToLayout, isNarrow);
  const navigate = useNavigate();
  const basePath = project ? `/repos/${encodeURIComponent(project.id)}/knowledge` : "/knowledge";
  const linkTo = (path: string, query = params) => `${path}${query.size ? `?${query}` : ""}`;
  const listHref = linkTo(basePath);
  const landingParams = new URLSearchParams(params);
  filterNames.forEach((name) => landingParams.delete(name));
  landingParams.delete("view");
  const allKnowledgeHref = linkTo(basePath, landingParams);
  const rulesParams = new URLSearchParams(landingParams);
  rulesParams.set("view", "rules");
  const browseParams = new URLSearchParams(landingParams);
  browseParams.set("view", "list");
  const browseHref = linkTo(basePath, browseParams);
  const grouping = params.get("view") === "area" ? "area" : "kind";
  const [query, setQuery] = useState(q);
  const writtenQuery = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addSession, setAddSession] = useState(0);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const [pendingAction, setPendingAction] = useState<{ key: string; action: KnowledgeItemAction }>();
  const initialAction = pendingAction && pendingAction.key === entryKey ? pendingAction.action : undefined;
  const areaOptions = filters.area ? [...new Set([
    ...view.areas.map(({ pattern }) => pattern), filters.area,
  ])].map((value) => ({ value, label: scopeLabel([value]) })) : [];
  const total = Object.values(view.counts).reduce((sum, count) => sum + count, 0);
  const repoNames = new Map(projects.map(({ id, name }) => [id, name]));
  const now = new Date();
  const isForgotten = entryKey === "forgotten";
  const title = useRef<HTMLHeadingElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const browser = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previousKey = useRef<string | undefined>(undefined);
  const focusedDetail = useRef<string | undefined>(undefined);
  const previousList = useRef(showList);
  const firstNewRow = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (entryKey && entryKey !== previousKey.current && (narrow || !previousList.current)) document.scrollingElement?.scrollTo(0, 0);
    const focusKey = view.detailMissing ? entryKey + ":missing" : entryKey;
    if (entryKey && detailTitle.current && focusedDetail.current !== focusKey && (!initialAction || detail || view.detailMissing)) {
      focusedDetail.current = focusKey;
      if (initialAction) setPendingAction(undefined);
      else detailTitle.current.focus({ preventScroll: true });
    } else if (!entryKey && !browser.current?.contains(document.activeElement)) {
      const row = Array.from(browser.current?.querySelectorAll<HTMLAnchorElement>("[data-item-key]") ?? [])
        .find((link) => link.dataset.itemKey === previousKey.current);
      (row ?? title.current)?.focus();
    }
    if (!entryKey) focusedDetail.current = undefined;
    previousKey.current = entryKey;
    previousList.current = showList;
  }, [entryKey, detail?.key, detailLoad?.loading, detailLoad?.error, initialAction, showList, narrow, view.detailMissing]);

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

  if (isForgotten) return <ForgottenView backHref={listHref} fetching={view.fetching} items={forgotten} load={load} loadMore={view.loadMore}
    partial={view.partial} repoNames={repoNames} titleRef={detailTitle} />;

  return (
    <div className={styles.page} data-detail={Boolean(entryKey)} ref={browser}>
      <div className={styles.overview}>
        <KnowledgeHeader
          action={(
            <div className={styles.headerActions}>
              {tools && <KnowledgeBrief preferredRepo={filters.repoId} previewBrief={tools.previewBrief} project={project} projects={projects} />}
              <Button aria-haspopup="dialog" className={styles.addButton} onClick={startAdd} type="button"><Plus aria-hidden="true" /> Add a note</Button>
            </div>
          )}
          scope={project?.name ?? "All repos"}
          titleRef={title}
          updating={view.updating}
        />
        <KnowledgeSummary
          active={statusFilter}
          browseHref={showList ? undefined : browseHref}
          counts={view.counts}
          onToggle={(slug) => changeFilter("status", statusFilter === slug ? "" : slug)}
          total={total}
        />
        {landing && (
          <KnowledgeNeedsLook
            canEditHints={live}
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
          <div className={styles.relatedLinks}>
            {tools && <Link className={shared.textLink} to={linkTo(basePath, rulesParams)}>Rule files</Link>}
            <Link className={shared.textLink} to={linkTo(`${basePath}/forgotten`)}>
              Forgotten{view.forgottenCount !== undefined && ` (${number.format(view.forgottenCount)})`}
            </Link>
          </div>
        </div>
        {showList && (
          <Link className={`${shared.textLink} ${styles.back}`} to={allKnowledgeHref}><ArrowLeft aria-hidden="true" /> All knowledge</Link>
        )}
        <KnowledgePartial partial={view.partial} repoNames={repoNames} />
        {load?.error && <KnowledgeLoad label="Knowledge" load={{ ...load, loading: false }} />}
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
            <ul aria-label="Items" className={styles.rows} data-many={live && items.length > 100} role="list">
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
              <p role="status">Showing {number.format(items.length)} of {number.format(view.total)}</p>
              {view.loadMore && (
                <Button
                  disabled={view.fetching}
                  onClick={() => {
                    firstNewRow.current = items.length;
                    view.loadMore?.();
                  }}
                  size="sm"
                  variant="outline"
                >Load more</Button>
              )}
            </div>
          </section>
        ) : load?.loading ? (
          <KnowledgeLoad label="Knowledge" load={load} />
        ) : !load?.error && (
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
          !detail && (detailLoad?.loading || detailLoad?.error) ? <KnowledgeLoad label="item" load={detailLoad} /> : <KnowledgeDetailPanel
            backHref={listHref}
            canEditHint={live}
            initialAction={initialAction}
            item={detail}
            key={view.detailMissing ? entryKey + ":missing" : entryKey}
            knowledge={knowledge}
            narrow={narrow}
            now={now}
            onForgotten={() => {
              setNotice("Item moved to Forgotten.");
              navigate(listHref, { replace: true });
            }}
            onUpdated={(updated) => {
              if (updated.key !== entryKey) navigate(itemHref(updated), { replace: true });
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
        onSave={async (request, onRetry) => {
          const { item } = await knowledge.createNote(request, onRetry);
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

function FixtureKnowledgePage({ knowledge, ...scope }: KnowledgeScope & { knowledge: KnowledgePreview }) {
  const route = useKnowledgeRoute(scope);
  const { entryKey, filters, showList } = route;
  const filterKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ filterKey, pageCount: 1 });
  const first = knowledge.getPage(filters);
  let page = first;
  const items = [...first.items];
  for (let n = 1; paging.filterKey === filterKey && n < paging.pageCount && page.nextCursor; n++) {
    page = knowledge.getPage(filters, page.nextCursor);
    items.push(...page.items);
  }
  const forgotten = knowledge.forgotten.filter(({ repoId }) => !scope.project || repoId === scope.project.id);
  const item = entryKey && entryKey !== "forgotten" ? knowledge.getDetail(entryKey) : undefined;
  const view: KnowledgeView = {
    items, total: first.total, counts: first.counts.status, updating: first.updatingSince,
    landing: showList ? undefined : knowledge.getLanding(scope.project?.id),
    areas: filters.area ? knowledge.getLanding(scope.project?.id ?? filters.repoId).groups.byArea : [],
    forgotten, forgottenCount: forgotten.length,
    detail: !scope.project || item?.repoId === scope.project.id ? item : undefined,
    loadMore: entryKey !== "forgotten" && page.nextCursor ? () => setPaging({ filterKey, pageCount: paging.filterKey === filterKey ? paging.pageCount + 1 : 2 }) : undefined,
  };
  return <KnowledgeBrowser {...scope} knowledge={knowledge} route={route} view={view} />;
}

function LiveKnowledgePage({ live, ...scope }: KnowledgeScope & { live: KnowledgeConnection }) {
  const route = useKnowledgeRoute(scope);
  const { entryKey, filters, showList } = route;
  const { events, csrfToken, reportDataError } = live;
  const isForgotten = entryKey === "forgotten";
  const repo = filters.scopeId ?? filters.repoId;
  const list = useKnowledgePage(filters, events, showList && !isForgotten);
  const landing = useKnowledgeLanding(repo, events, !showList || Boolean(filters.area && !isForgotten));
  const detail = useKnowledgeItem(isForgotten ? undefined : entryKey, events);
  const forgotten = useForgotten(repo, events, isForgotten);
  const actions = useKnowledgeActions(csrfToken, reportDataError);
  useEffect(() => {
    for (const error of [list.error, landing.error, detail.error, forgotten.error]) if (error) reportDataError(error);
  }, [list.error, landing.error, detail.error, forgotten.error, reportDataError]);

  const firstPage = list.data?.pages[0];
  const firstForgotten = forgotten.data?.pages[0];
  const active = isForgotten ? forgotten : showList ? list : landing;
  const current = isForgotten ? firstForgotten : showList ? firstPage : landing.data;
  const paging = isForgotten ? forgotten : list;
  const counts = (showList ? firstPage?.counts.status : undefined) ?? emptyCounts();
  if (!showList && landing.data) {
    for (const group of landing.data.groups.byKind) {
      for (const { key } of knowledgeStatuses) counts[key] += group.statusCounts[key];
    }
  }
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const forgottenItems = forgotten.data?.pages.flatMap((page) => page.items) ?? [];
  const detailMissing = detail.error instanceof HubProblemError && detail.error.status === 404;
  const item = !detailMissing && (!scope.project || detail.data?.repoId === scope.project.id) ? detail.data : undefined;
  const view: KnowledgeView = {
    items, total: firstPage?.total ?? 0, counts,
    landing: !showList && !(landing.data?.updatingSince && landing.data.groups.byKind.length === 0) ? landing.data : undefined,
    areas: landing.data?.groups.byArea ?? [],
    detail: item, detailMissing, detailLoad: entryKey ? { loading: detail.isPending, error: detail.isError && !detailMissing, retry: () => void detail.refetch() } : undefined,
    forgotten: forgottenItems, forgottenCount: firstForgotten && !forgotten.hasNextPage ? forgottenItems.length : undefined,
    updating: current?.updatingSince, partial: current?.partial,
    load: {
      loading: active.isPending || Boolean(current?.updatingSince && (isForgotten ? !forgottenItems.length : !showList || !items.length)),
      error: active.isError, retry: () => void active.refetch(),
    },
    loadMore: paging.hasNextPage ? () => void paging.fetchNextPage({ cancelRefetch: false }) : undefined,
    fetching: paging.isFetching,
  };
  return <KnowledgeBrowser {...scope} knowledge={actions} live route={route} view={view} />;
}

export default function KnowledgePage({ knowledge, live, ...scope }: KnowledgePageProps) {
  const [params] = useSearchParams();
  if (knowledge && params.get("view") === "rules") return <KnowledgeRules {...scope} tools={knowledge.tools} />;
  return knowledge ? <FixtureKnowledgePage {...scope} knowledge={knowledge} /> : <LiveKnowledgePage {...scope} live={live} />;
}
