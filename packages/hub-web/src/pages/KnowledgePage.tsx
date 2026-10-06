import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  BookOpenText,
  ChevronRight,
  GitCommitHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { HubApiError } from "../api/client";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  SearchResponse,
  WikiBacklinksResponse,
  WikiEntityDetailResponse,
  WikiEntityListRequest,
  WikiEntityListResponse,
  WikiEntitySummary,
  WikiGrounding,
  WikiGroundingHealth,
  WikiLifecycleState,
  WikiRelation,
  WikiRelationHit,
  WikiRelationsResponse,
  WikiSearchResult,
  WikiSource,
} from "../api/types";
import { ErrorState, formatDate, PageHeader, sentenceCase, StatePanel, StatusPill, stateTone } from "../components/ui";
import { Badge } from "../components/primitives/badge";
import { Button, buttonVariants } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import { Input } from "../components/primitives/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../components/primitives/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
import {
  appendBoundedUnique,
  MAX_ACCUMULATED_WORKBENCH_ITEMS,
} from "../lib/bounds";
import { cn } from "../lib/utils";
import styles from "../styles/knowledge.module.css";

const lifecycleValues: WikiLifecycleState[] = ["in_flight", "promoted", "deprecated", "archived"];
const groundingValues: WikiGroundingHealth[] = ["fresh", "changed", "missing", "ambiguous", "unverified"];
const problemCodes = ["INDEX_MISSING", "INDEX_STALE", "INDEX_CORRUPT", "MIGRATION_REQUIRED"];
const wikiEntityIdLength = 29;
type KnowledgeListItem = WikiEntitySummary | WikiSearchResult;

interface KnowledgeCollection {
  indexedRevision: string;
  items: KnowledgeListItem[];
  nextCursor: string | null;
  truncated: boolean;
}

function isWikiSearchResult(item: KnowledgeListItem): item is WikiSearchResult {
  return "entityKind" in item;
}

function isGraphSymbolId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= 128;
}

function healthTone(health: WikiGroundingHealth) {
  if (health === "fresh") return "success" as const;
  if (health === "missing") return "danger" as const;
  if (health === "changed" || health === "ambiguous") return "warning" as const;
  return "neutral" as const;
}

/** Health that `mex check` flags and `mex sync` reviews; the same verdict the CLI reports. */
function needsReview(health: WikiGroundingHealth): boolean {
  return health === "changed" || health === "missing" || health === "ambiguous";
}

function wikiProblemTitle(code: string | undefined): string {
  if (code === "INDEX_STALE") return "The Knowledge index is stale";
  if (code === "INDEX_CORRUPT") return "The Knowledge index is corrupt";
  if (code === "MIGRATION_REQUIRED") return "Knowledge migration is required";
  return "A trustworthy Knowledge index is unavailable";
}

function WikiProblem({ error, retry }: { error: unknown; retry: () => void }) {
  const problem = error instanceof HubApiError ? error.problem : null;
  if (problem && problemCodes.includes(problem.code)) {
    return (
      <StatePanel
        action={<Link className={buttonVariants({ size: "sm", variant: "outline" })} to="/health">Open Wiki health</Link>}
        detail="Knowledge reads only return a trustworthy indexed revision. Inspect Health before choosing an explicit repair operation."
        state="unavailable"
        title={wikiProblemTitle(problem.code)}
      />
    );
  }
  return <ErrorState error={error} retry={retry} />;
}

function EntityRow({ item }: { item: KnowledgeListItem }) {
  const kind = isWikiSearchResult(item) ? item.entityKind : item.kind;
  const path = isWikiSearchResult(item) ? item.path : item.location.path;
  const diagnostics = isWikiSearchResult(item) ? [] : item.diagnostics;
  const matchedFields = isWikiSearchResult(item) ? item.matchedFields : [];
  return (
    <Item className={styles.entityRow} render={<Link to={item.route} />}>
      <ItemMedia className={styles.entityGlyph} variant="icon"><BookOpenText aria-hidden="true" /></ItemMedia>
      <ItemContent className={styles.entityBody}>
        <span className={styles.entityKicker}>
          <span>{kind}</span>
          <span aria-hidden="true">·</span>
          <span>{sentenceCase(item.lifecycleState)}</span>
        </span>
        <ItemTitle>{item.title}</ItemTitle>
        {item.summary ? <p className={styles.entitySummary}>{item.summary}</p> : null}
        <span className={styles.entityMeta}>
          <span>{path}</span>
          {matchedFields.length ? <span>matched {matchedFields.join(", ")}</span> : null}
          {diagnostics.length ? <span>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</span> : null}
        </span>
        <span className={styles.tagRow}>
          <StatusPill tone={healthTone(item.groundingHealth)}>{sentenceCase(item.groundingHealth)}</StatusPill>
          {item.topics.slice(0, 4).map((topic, index) => <Badge className={styles.topicBadge} key={`${topic}-${index}`} variant="outline">{topic}</Badge>)}
          {item.topicsTruncated ? <Badge className={styles.topicBadge} variant="outline">More topics omitted</Badge> : null}
          {item.sourceTypes.slice(0, 3).map((sourceType, index) => <Badge className={styles.topicBadge} key={`${sourceType}-${index}`} variant="secondary">{sourceType}</Badge>)}
          {item.sourceTypesTruncated ? <Badge className={styles.topicBadge} variant="secondary">More sources omitted</Badge> : null}
        </span>
      </ItemContent>
      <ItemActions className={styles.entityRouteIcon}><ArrowUpRight aria-hidden="true" /></ItemActions>
    </Item>
  );
}

function collectionFromList(response: WikiEntityListResponse): KnowledgeCollection {
  return {
    indexedRevision: response.indexedRevision,
    items: response.items,
    nextCursor: response.nextCursor,
    truncated: response.truncated,
  };
}

function collectionFromSearch(response: SearchResponse): KnowledgeCollection | null {
  const group = response.groups.wiki;
  if (group.status !== "available" || group.revision === null) return null;
  return {
    indexedRevision: group.revision,
    items: group.items.filter((item): item is WikiSearchResult => item.kind === "wiki"),
    nextCursor: group.nextCursor,
    truncated: group.truncated,
  };
}

function KnowledgeBrowse({ embedded = false }: { embedded?: boolean }) {
  const api = useHubApi();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [params, updateParams] = useSearchParams();
  const setParams = (next: Record<string, string>) => updateParams(params.get("view") === "list" ? { view: "list", ...next } : next);
  const query = (params.get("q") ?? "").trim().slice(0, 256);
  const activeFilters = {
    kind: (params.get("kind") ?? "").trim().slice(0, 128),
    topic: (params.get("topic") ?? "").trim().slice(0, wikiEntityIdLength),
    lifecycle: (params.get("lifecycle") ?? "") as WikiLifecycleState | "",
    grounding: (params.get("grounding") ?? "") as WikiGroundingHealth | "",
    sourceType: (params.get("sourceType") ?? "").trim().slice(0, 128),
  };
  const [draftQuery, setDraftQuery] = useState(query);
  const [draftFilters, setDraftFilters] = useState(activeFilters);
  const [collection, setCollection] = useState<KnowledgeCollection | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const requestKey = params.toString();
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  const enabled = capabilities?.wiki.read.availability === "available";
  const listRequest: WikiEntityListRequest = {
    limit: 25,
    ...(activeFilters.kind ? { kind: activeFilters.kind } : {}),
    ...(activeFilters.topic ? { topic: activeFilters.topic } : {}),
    ...(activeFilters.lifecycle ? { lifecycle: activeFilters.lifecycle } : {}),
    ...(activeFilters.grounding ? { grounding: activeFilters.grounding } : {}),
    ...(activeFilters.sourceType ? { sourceType: activeFilters.sourceType } : {}),
  };
  const list = useQuery({
    queryKey: ["wiki-entities", activeFilters.kind, activeFilters.topic, activeFilters.lifecycle, activeFilters.grounding, activeFilters.sourceType],
    queryFn: () => api.listWikiEntities(listRequest),
    enabled: enabled && !query,
    retry: false,
  });
  const search = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search({ q: query, limit: 25 }),
    enabled: enabled && Boolean(query),
    retry: false,
  });
  const pagination = useMutation({
    mutationFn: async (startedRequestKey: string) => {
      if (!collection?.nextCursor) return { next: null, startedRequestKey };
      if (query) {
        const response = await api.search({ q: query, limit: 25, wikiCursor: collection.nextCursor });
        const group = response.groups.wiki;
        if (group.status !== "available") {
          if (group.code === "REVISION_CONFLICT") throw new HubApiError({ type: "about:blank", title: "Knowledge changed", status: 409, code: "REVISION_CONFLICT", detail: group.detail ?? "Knowledge changed while paging.", requestId: crypto.randomUUID() });
          throw new Error("Knowledge search page unavailable");
        }
        return { next: collectionFromSearch(response), startedRequestKey };
      }
      return {
        next: collectionFromList(await api.listWikiEntities({ ...listRequest, cursor: collection.nextCursor })),
        startedRequestKey,
      };
    },
    onSuccess: ({ next, startedRequestKey }) => {
      if (startedRequestKey !== requestKeyRef.current) return;
      if (!next || !collection) return;
      if (next.indexedRevision !== collection.indexedRevision) {
        setRevisionConflict(true);
        return;
      }
      const accumulated = appendBoundedUnique(collection.items, next.items, (item) => item.id);
      const boundReached = accumulated.omitted
        || (accumulated.items.length >= MAX_ACCUMULATED_WORKBENCH_ITEMS && next.nextCursor !== null);
      setCollection({
        ...next,
        items: accumulated.items,
        nextCursor: boundReached ? null : next.nextCursor,
        truncated: next.truncated || boundReached,
      });
    },
    onError: (error, startedRequestKey) => {
      if (startedRequestKey !== requestKeyRef.current) return;
      if (error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
      else setPageFailed(true);
    },
  });

  useEffect(() => {
    setDraftQuery(query);
    setDraftFilters(activeFilters);
    setCollection(null);
    setRevisionConflict(false);
    setPageFailed(false);
    pagination.reset();
  }, [requestKey]);

  useEffect(() => {
    const next = query
      ? search.data ? collectionFromSearch(search.data) : null
      : list.data ? collectionFromList(list.data) : null;
    if (next) {
      setCollection(next);
    }
  }, [query, list.data, search.data]);

  useEffect(() => {
    if (collection) summaryRef.current?.focus({ preventScroll: true });
  }, [requestKey, collection?.indexedRevision]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextQuery = draftQuery.trim().slice(0, 256);
    if (nextQuery) {
      setParams({ q: nextQuery });
      return;
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(draftFilters)) if (value) next[key] = value;
    setParams(next);
  }

  function clearAll() {
    setDraftQuery("");
    setDraftFilters({ kind: "", topic: "", lifecycle: "", grounding: "", sourceType: "" });
    setParams({});
  }

  async function reloadLatest() {
    const result = query ? await search.refetch() : await list.refetch();
    if (!result.isSuccess) return;
    const next = query ? collectionFromSearch(result.data as SearchResponse) : collectionFromList(result.data as WikiEntityListResponse);
    if (!next) return;
    setCollection(next);
    setRevisionConflict(false);
    setPageFailed(false);
  }

  const searchGroup = search.data?.groups.wiki;
  const pending = query ? search.isPending : list.isPending;
  const readError = query ? search.error : list.error;
  const hasFilters = Boolean(Object.values(activeFilters).some(Boolean));
  const hasPartialDiagnostics = collection?.items.some((item) => !isWikiSearchResult(item) && (item.diagnostics.length > 0 || item.diagnosticsTruncated)) ?? false;

  return (
    <div className={styles.page}>
      {!embedded && <PageHeader eyebrow="Read-only index" title="Knowledge" description="Browse durable project memory, inspect evidence, and follow only explicit links into code." />}
      {!capabilities ? (
        <StatePanel state="loading" title="Checking Knowledge availability" detail="Reading the process-local capability boundary before opening the Wiki index." />
      ) : capabilities.wiki.read.availability === "unavailable" ? (
        <StatePanel state="unavailable" title="Knowledge unavailable" detail={capabilities.wiki.read.reason ?? "A trustworthy Wiki reader is not connected in this build."} />
      ) : (
        <div className={styles.browseWorkbench}>
          <Card className={styles.browseCommand} size="sm">
            <CardContent className={styles.browseCommandContent}>
              <form className={styles.browseForm} onSubmit={submit} role="search">
                <div className={styles.searchField}>
                  <label htmlFor="knowledge-query">Search titles, summaries, and bodies</label>
                  <InputGroup className={styles.searchInputGroup}>
                    <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                    <InputGroupInput autoComplete="off" id="knowledge-query" maxLength={256} onChange={(event) => setDraftQuery(event.target.value)} placeholder="Search project knowledge" type="search" value={draftQuery} />
                    {draftQuery ? <InputGroupAddon align="inline-end"><InputGroupButton aria-label="Clear Knowledge search" onClick={() => setDraftQuery("")} size="icon-xs"><X aria-hidden="true" /></InputGroupButton></InputGroupAddon> : null}
                  </InputGroup>
                </div>
                <div className={styles.filterField}>
                  <label htmlFor="knowledge-kind">Kind</label>
                  <Input id="knowledge-kind" maxLength={128} onChange={(event) => setDraftFilters((current) => ({ ...current, kind: event.target.value }))} placeholder="Any kind" value={draftFilters.kind} />
                </div>
                <div className={styles.filterField}>
                  <label htmlFor="knowledge-topic">Topic ID</label>
                  <Input id="knowledge-topic" maxLength={wikiEntityIdLength} onChange={(event) => setDraftFilters((current) => ({ ...current, topic: event.target.value }))} placeholder="Any topic" value={draftFilters.topic} />
                </div>
                <div className={styles.filterField}>
                  <label htmlFor="knowledge-lifecycle">Lifecycle</label>
                  <select id="knowledge-lifecycle" onChange={(event) => setDraftFilters((current) => ({ ...current, lifecycle: event.target.value as WikiLifecycleState | "" }))} value={draftFilters.lifecycle}>
                    <option value="">Any lifecycle</option>
                    {lifecycleValues.map((value) => <option key={value} value={value}>{sentenceCase(value)}</option>)}
                  </select>
                </div>
                <div className={styles.filterField}>
                  <label htmlFor="knowledge-grounding">Grounding</label>
                  <select id="knowledge-grounding" onChange={(event) => setDraftFilters((current) => ({ ...current, grounding: event.target.value as WikiGroundingHealth | "" }))} value={draftFilters.grounding}>
                    <option value="">Any grounding</option>
                    {groundingValues.map((value) => <option key={value} value={value}>{sentenceCase(value)}</option>)}
                  </select>
                </div>
                <div className={styles.filterField}>
                  <label htmlFor="knowledge-source">Source type</label>
                  <Input id="knowledge-source" maxLength={128} onChange={(event) => setDraftFilters((current) => ({ ...current, sourceType: event.target.value }))} placeholder="Any source" value={draftFilters.sourceType} />
                </div>
                <Button className={styles.browseSubmit} disabled={!draftQuery.trim() && !Object.values(draftFilters).some(Boolean) && !query && !hasFilters} type="submit">Apply</Button>
              </form>
            </CardContent>
          </Card>

          {(query || hasFilters) ? <Button onClick={clearAll} size="sm" type="button" variant="ghost">Clear search and filters</Button> : null}
          {revisionConflict ? (
            <div className={styles.revisionConflict} role="alert">
              <RefreshCw aria-hidden="true" />
              <span><strong>Knowledge changed while you were paging.</strong>Loaded entries remain frozen; pages from different revisions will not be combined.</span>
              <Button disabled={list.isFetching || search.isFetching} onClick={() => void reloadLatest()} size="sm" type="button" variant="outline">Reload latest</Button>
            </div>
          ) : null}
          {hasPartialDiagnostics ? (
            <div className={styles.partialNotice} role="status"><AlertTriangle aria-hidden="true" /><span><strong>Some entries carry bounded diagnostics.</strong>Trustworthy entries remain visible; open a record for its safe diagnostic summary.</span></div>
          ) : null}
          {pending && !collection ? (
            <StatePanel state="loading" title={query ? `Searching Knowledge for “${query}”` : "Opening the Knowledge index"} detail="Reading one bounded Wiki revision without changing canonical files." />
          ) : readError && !collection ? (
            <WikiProblem error={readError} retry={() => void (query ? search.refetch() : list.refetch())} />
          ) : query && searchGroup?.status === "unavailable" ? (
            <StatePanel state="unavailable" title="Knowledge search unavailable" detail={searchGroup.detail ?? "The Wiki search reader is not connected."} />
          ) : query && searchGroup?.status === "failed" ? (
            <StatePanel action={<Button onClick={() => void search.refetch()} size="sm" type="button" variant="outline">Try again</Button>} state="error" title={wikiProblemTitle(searchGroup.code)} detail={searchGroup.detail ?? "Knowledge search failed independently."} />
          ) : collection ? (
            <>
              <div className={styles.browseSummary} aria-live="polite" ref={summaryRef} tabIndex={-1}>
                <span>{query ? `Knowledge results for “${query}”` : hasFilters ? "Filtered Knowledge records" : "All Knowledge records"}</span>
                <code>revision {collection.indexedRevision.slice(0, 10)}</code>
              </div>
              <Card className={styles.entityCard} size="sm">
                <CardHeader className={styles.entityCardHeader}>
                  <CardTitle><h2>{query ? "Search results" : "Indexed records"}</h2></CardTitle>
                  <CardAction><StatusPill>{collection.items.length} loaded</StatusPill></CardAction>
                </CardHeader>
                <CardContent className={styles.entityCardContent}>
                  {collection.items.length ? <div className={styles.entityResults}>{collection.items.map((item) => <EntityRow item={item} key={item.id} />)}</div> : (
                    <StatePanel compact state="empty" title={query ? "No Knowledge matched this search" : hasFilters ? "No Knowledge matches these filters" : "No Knowledge records yet"} detail="The Wiki read completed successfully and returned no entries." />
                  )}
                </CardContent>
                {pageFailed && !revisionConflict ? (
                  <CardFooter className={styles.paginationProblem} role="alert">
                    <AlertTriangle aria-hidden="true" />
                    <span><strong>Older Knowledge could not be loaded.</strong>Entries already on screen are unchanged.</span>
                    <Button onClick={() => { setPageFailed(false); pagination.mutate(requestKey); }} size="sm" type="button" variant="outline">Try again</Button>
                  </CardFooter>
                ) : collection.nextCursor && !revisionConflict ? (
                  <CardFooter className={styles.loadFooter}><Button disabled={pagination.isPending} onClick={() => pagination.mutate(requestKey)} type="button" variant="outline">{pagination.isPending ? "Loading…" : "Load more Knowledge"}</Button></CardFooter>
                ) : collection.truncated ? <CardFooter className={styles.boundedFooter}>This result reached its safety bound. Narrow the search or filters to continue.</CardFooter> : null}
              </Card>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SourceRow({ source }: { source: WikiSource }) {
  return (
    <div className={styles.contextRow}>
      <div><strong>{sentenceCase(source.type)}</strong>{source.capturedAt ? <small>{formatDate(source.capturedAt)}</small> : null}</div>
      {source.ref ? <code>{source.ref}</code> : null}
      {source.repository ? <code>{source.repository}</code> : null}
      {source.note ? <p>{source.note}</p> : null}
      {source.commit ? <code><GitCommitHorizontal aria-hidden="true" /> {source.commit}</code> : null}
    </div>
  );
}

function GroundingRow({ grounding }: { grounding: WikiGrounding }) {
  const node = grounding.resolvedNode ?? grounding.requestedNode;
  const content = (
    <>
      <div><strong>{node ?? "No code node recorded"}</strong><StatusPill tone={healthTone(grounding.health)}>{sentenceCase(grounding.health)}</StatusPill></div>
      <p>{sentenceCase(grounding.state)}{grounding.verifiedAt ? ` · verified ${formatDate(grounding.verifiedAt)}` : ""}</p>
      {grounding.file ? <code>{grounding.file}</code> : null}
      {grounding.commit ? <code>{grounding.commit}</code> : null}
      {grounding.reason ? <p>{grounding.reason}</p> : null}
      {grounding.candidates.length ? <p>{grounding.candidates.length} bounded candidate{grounding.candidates.length === 1 ? "" : "s"}{grounding.candidatesTruncated ? ", more omitted" : ""}</p> : null}
    </>
  );
  return isGraphSymbolId(node)
    ? <Link className={styles.contextRow} to={`/code/symbols/${encodeURIComponent(node)}`}>{content}</Link>
    : <div className={styles.contextRow}>{content}</div>;
}

function RelationRow({ hit }: { hit: WikiRelationHit }) {
  return (
    <Link className={styles.edgeRow} to={hit.entity.route}>
      <div><strong>{hit.entity.title}</strong><Badge variant="outline">{hit.direction}</Badge></div>
      <code>{hit.relation.type}</code>
      {hit.relation.note ? <p>{hit.relation.note}</p> : null}
    </Link>
  );
}

function BacklinkRow({ relation, entityId }: { relation: WikiRelation; entityId: string }) {
  const related = relation.source.id === entityId ? relation.target : relation.source;
  return (
    <Link className={styles.edgeRow} to={`/knowledge/${encodeURIComponent(related.id)}`}>
      <div><strong>{related.title ?? related.id}</strong><Badge variant="outline">incoming</Badge></div>
      <code>{relation.type}</code>
      {relation.note ? <p>{relation.note}</p> : null}
    </Link>
  );
}

function DetailIdentity({ detail }: { detail: WikiEntityDetailResponse }) {
  const { entity } = detail;
  return (
    <div className={styles.railStack}>
      <Card className={styles.workspaceCard} size="sm">
        <CardHeader><Badge variant="secondary">{entity.kind}</Badge><CardTitle><h2>Record identity</h2></CardTitle></CardHeader>
        <CardContent>
          <dl className={styles.factList}>
            <div><dt>Entity ID</dt><dd className={styles.mono}>{entity.id}</dd></div>
            <div><dt>Lifecycle</dt><dd>{sentenceCase(entity.lifecycleState)}</dd></div>
            <div><dt>Canonical source</dt><dd className={styles.mono}>{entity.location.path}:{entity.location.startLine}–{entity.location.endLine}</dd></div>
            <div><dt>Semantic revision</dt><dd className={styles.mono}>{entity.version.semanticRevision}</dd></div>
            <div><dt>Content hash</dt><dd className={styles.mono}>{entity.version.contentHash.slice(0, 14)}</dd></div>
          </dl>
        </CardContent>
      </Card>
      <Card className={styles.workspaceCard} size="sm">
        <CardHeader><CardTitle><h2>Topics & sources</h2></CardTitle></CardHeader>
        <CardContent className={styles.detailStack}>
          <div className={styles.tagRow}>{entity.topics.length ? entity.topics.map((topic) => <Badge className={styles.topicBadge} key={topic} variant="outline">{topic}</Badge>) : <span className={styles.sectionLabel}>No topics recorded</span>}</div>
          <div className={styles.tagRow}>{entity.sourceTypes.map((sourceType) => <Badge className={styles.topicBadge} key={sourceType} variant="secondary">{sourceType}</Badge>)}</div>
        </CardContent>
      </Card>
      {entity.diagnostics.length || entity.diagnosticsTruncated ? (
        <Card className={styles.workspaceCard} size="sm">
          <CardHeader><CardTitle><h2>Diagnostics</h2></CardTitle></CardHeader>
          <CardContent>
            <ul className={styles.diagnosticList}>{entity.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>)}</ul>
            {entity.diagnosticsTruncated ? <p className={styles.bodyBound}>Additional diagnostics were omitted.</p> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function EdgePanel({
  entityId,
  relations,
  backlinks,
  relationError,
  backlinkError,
  relationPending,
  backlinkPending,
  relationCursor,
  backlinkCursor,
  relationTruncated,
  backlinkTruncated,
  onLoadRelations,
  onLoadBacklinks,
  loadingRelations,
  loadingBacklinks,
}: {
  entityId: string;
  relations: WikiRelationHit[];
  backlinks: WikiRelation[];
  relationError: boolean;
  backlinkError: boolean;
  relationPending: boolean;
  backlinkPending: boolean;
  relationCursor: string | null;
  backlinkCursor: string | null;
  relationTruncated: boolean;
  backlinkTruncated: boolean;
  onLoadRelations: () => void;
  onLoadBacklinks: () => void;
  loadingRelations: boolean;
  loadingBacklinks: boolean;
}) {
  return (
    <Card className={styles.workspaceCard} size="sm">
      <CardHeader><CardTitle><h2>Knowledge links</h2></CardTitle></CardHeader>
      <CardContent className={styles.edgeCardContent}>
        <Tabs className={styles.edgeTabs} defaultValue="relations">
          <TabsList activateOnFocus aria-label="Inspect Knowledge links" className={styles.edgeTabList} variant="line">
            <TabsTrigger value="relations">Relations</TabsTrigger>
            <TabsTrigger value="backlinks">Backlinks</TabsTrigger>
          </TabsList>
          <TabsContent className={styles.edgeTabPanel} value="relations">
            {relationPending && !relations.length ? <StatePanel compact state="loading" title="Loading relations" detail="Reading explicit Wiki edges." />
              : relations.length ? relations.map((hit, index) => <RelationRow hit={hit} key={`${hit.entity.id}-${hit.relation.type}-${index}`} />)
                : <StatePanel compact state="empty" title="No relations recorded" detail="This entry has no explicit outgoing or incoming relation in the selected page." />}
            {relationError ? <div className={styles.paginationProblem} role="alert"><AlertTriangle aria-hidden="true" /><span><strong>Relations could not be loaded.</strong>Trusted detail remains visible.</span><Button onClick={onLoadRelations} size="sm" type="button" variant="outline">Try again</Button></div>
              : relationCursor ? <div className={styles.tabFooter}><Button disabled={loadingRelations} onClick={onLoadRelations} type="button" variant="outline">{loadingRelations ? "Loading…" : "Load more relations"}</Button></div>
                : relationTruncated ? <p className={styles.bodyBound}>Relation results reached their safety bound.</p> : null}
          </TabsContent>
          <TabsContent className={styles.edgeTabPanel} value="backlinks">
            {backlinkPending && !backlinks.length ? <StatePanel compact state="loading" title="Loading backlinks" detail="Reading explicit references to this entry." />
              : backlinks.length ? backlinks.map((relation, index) => <BacklinkRow entityId={entityId} key={`${relation.source.id}-${relation.target.id}-${relation.type}-${index}`} relation={relation} />)
                : <StatePanel compact state="empty" title="No backlinks recorded" detail="No other indexed entry explicitly references this record." />}
            {backlinkError ? <div className={styles.paginationProblem} role="alert"><AlertTriangle aria-hidden="true" /><span><strong>Backlinks could not be loaded.</strong>Trusted detail remains visible.</span><Button onClick={onLoadBacklinks} size="sm" type="button" variant="outline">Try again</Button></div>
              : backlinkCursor ? <div className={styles.tabFooter}><Button disabled={loadingBacklinks} onClick={onLoadBacklinks} type="button" variant="outline">{loadingBacklinks ? "Loading…" : "Load more backlinks"}</Button></div>
                : backlinkTruncated ? <p className={styles.bodyBound}>Backlink results reached their safety bound.</p> : null}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function KnowledgeDetail() {
  const api = useHubApi();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const { id = "" } = useParams();
  const enabled = capabilities?.wiki.read.availability === "available";
  const headerRef = useRef<HTMLElement>(null);
  const detail = useQuery({ queryKey: ["wiki-entity", id], queryFn: () => api.getWikiEntity(id), enabled, retry: false });
  const relationPage = useQuery({ queryKey: ["wiki-relations", id], queryFn: () => api.getWikiRelations(id, { direction: "both", limit: 25 }), enabled, retry: false });
  const backlinkPage = useQuery({ queryKey: ["wiki-backlinks", id], queryFn: () => api.getWikiBacklinks(id, { limit: 25 }), enabled, retry: false });
  const [response, setResponse] = useState<WikiEntityDetailResponse | null>(null);
  const [relations, setRelations] = useState<WikiRelationHit[]>([]);
  const [backlinks, setBacklinks] = useState<WikiRelation[]>([]);
  const [relationCursor, setRelationCursor] = useState<string | null>(null);
  const [backlinkCursor, setBacklinkCursor] = useState<string | null>(null);
  const [relationTruncated, setRelationTruncated] = useState(false);
  const [backlinkTruncated, setBacklinkTruncated] = useState(false);
  const [relationRecovered, setRelationRecovered] = useState(false);
  const [backlinkRecovered, setBacklinkRecovered] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const loadRelations = useMutation({
    mutationFn: (started: { entityId: string; indexedRevision: string; cursor: string | null }) => api.getWikiRelations(
      started.entityId,
      { direction: "both", limit: 25, ...(started.cursor ? { cursor: started.cursor } : {}) },
    ),
    onSuccess: (next, started) => {
      if (started.entityId !== id || response?.entity.id !== started.entityId) return;
      if (response.indexedRevision !== started.indexedRevision || next.indexedRevision !== response.indexedRevision) { setRevisionConflict(true); return; }
      const accumulated = appendBoundedUnique(
        relations,
        next.items,
        (item) => `${item.entity.id}\0${item.relation.type}\0${item.direction}`,
      );
      const boundReached = accumulated.omitted
        || (accumulated.items.length >= MAX_ACCUMULATED_WORKBENCH_ITEMS && next.nextCursor !== null);
      setRelations(accumulated.items);
      setRelationCursor(boundReached ? null : next.nextCursor);
      setRelationTruncated(next.truncated || boundReached);
      setRelationRecovered(true);
    },
    onError: (error, started) => {
      if (started.entityId === id && response?.entity.id === started.entityId && error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
    },
  });
  const loadBacklinks = useMutation({
    mutationFn: (started: { entityId: string; indexedRevision: string; cursor: string | null }) => api.getWikiBacklinks(
      started.entityId,
      { limit: 25, ...(started.cursor ? { cursor: started.cursor } : {}) },
    ),
    onSuccess: (next, started) => {
      if (started.entityId !== id || response?.entity.id !== started.entityId) return;
      if (response.indexedRevision !== started.indexedRevision || next.indexedRevision !== response.indexedRevision) { setRevisionConflict(true); return; }
      const accumulated = appendBoundedUnique(
        backlinks,
        next.items,
        (item) => `${item.source.id}\0${item.target.id}\0${item.type}`,
      );
      const boundReached = accumulated.omitted
        || (accumulated.items.length >= MAX_ACCUMULATED_WORKBENCH_ITEMS && next.nextCursor !== null);
      setBacklinks(accumulated.items);
      setBacklinkCursor(boundReached ? null : next.nextCursor);
      setBacklinkTruncated(next.truncated || boundReached);
      setBacklinkRecovered(true);
    },
    onError: (error, started) => {
      if (started.entityId === id && response?.entity.id === started.entityId && error instanceof HubApiError && error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
    },
  });

  useEffect(() => {
    setResponse(null);
    setRelations([]);
    setBacklinks([]);
    setRelationCursor(null);
    setBacklinkCursor(null);
    setRelationTruncated(false);
    setBacklinkTruncated(false);
    setRelationRecovered(false);
    setBacklinkRecovered(false);
    setRevisionConflict(false);
    loadRelations.reset();
    loadBacklinks.reset();
  }, [id]);

  useEffect(() => {
    if (!detail.data) return;
    if (response) {
      if (detail.data.indexedRevision !== response.indexedRevision) setRevisionConflict(true);
      return;
    }
    if (relationPage.isPending || backlinkPage.isPending) return;
    if (
      (relationPage.data && relationPage.data.indexedRevision !== detail.data.indexedRevision)
      || (backlinkPage.data && backlinkPage.data.indexedRevision !== detail.data.indexedRevision)
    ) {
      setRevisionConflict(true);
      return;
    }

    // Publish the initial body and both independently loaded edge panels as one
    // displayed Wiki generation. A failed panel contributes no rows; it never
    // causes cached rows from another revision to be paired with this body.
    setResponse(detail.data);
    setRelations(relationPage.data?.items ?? []);
    setRelationCursor(relationPage.data?.nextCursor ?? null);
    setRelationTruncated(relationPage.data?.truncated ?? false);
    setRelationRecovered(false);
    setBacklinks(backlinkPage.data?.items ?? []);
    setBacklinkCursor(backlinkPage.data?.nextCursor ?? null);
    setBacklinkTruncated(backlinkPage.data?.truncated ?? false);
    setBacklinkRecovered(false);
  }, [detail.data, response, relationPage.data, relationPage.isPending, backlinkPage.data, backlinkPage.isPending]);

  useEffect(() => {
    if (relationPage.error instanceof HubApiError && relationPage.error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
    if (backlinkPage.error instanceof HubApiError && backlinkPage.error.problem.code === "REVISION_CONFLICT") setRevisionConflict(true);
  }, [relationPage.error, backlinkPage.error]);

  useEffect(() => {
    if (response) headerRef.current?.focus({ preventScroll: true });
  }, [response?.entity.id]);

  async function reloadLatest() {
    const [nextDetail, nextRelations, nextBacklinks] = await Promise.all([detail.refetch(), relationPage.refetch(), backlinkPage.refetch()]);
    if (!nextDetail.isSuccess || !nextRelations.isSuccess || !nextBacklinks.isSuccess) return;
    const revision = nextDetail.data.indexedRevision;
    if (nextRelations.data.indexedRevision !== revision || nextBacklinks.data.indexedRevision !== revision) return;
    setResponse(nextDetail.data);
    setRelations(nextRelations.data.items);
    setBacklinks(nextBacklinks.data.items);
    setRelationCursor(nextRelations.data.nextCursor);
    setBacklinkCursor(nextBacklinks.data.nextCursor);
    setRelationTruncated(nextRelations.data.truncated);
    setBacklinkTruncated(nextBacklinks.data.truncated);
    setRelationRecovered(false);
    setBacklinkRecovered(false);
    setRevisionConflict(false);
    loadRelations.reset();
    loadBacklinks.reset();
  }

  const visibleResponse = response?.entity.id === id ? response : null;
  const relationMutationCurrent = loadRelations.variables?.entityId === id
    && loadRelations.variables.indexedRevision === visibleResponse?.indexedRevision;
  const backlinkMutationCurrent = loadBacklinks.variables?.entityId === id
    && loadBacklinks.variables.indexedRevision === visibleResponse?.indexedRevision;
  const workspacePending = !visibleResponse && detail.data !== undefined
    && (relationPage.isPending || backlinkPage.isPending);
  const partial = Boolean(visibleResponse && (
    visibleResponse.body.truncated
    || visibleResponse.sources.truncated
    || visibleResponse.groundings.truncated
    || visibleResponse.entity.diagnosticsTruncated
    || detail.isError
    || (relationPage.isError && !relationRecovered)
    || (backlinkPage.isError && !backlinkRecovered)
  ));

  return (
    <div className={styles.page}>
      <Link className={cn(buttonVariants({ size: "sm", variant: "ghost" }), styles.backLink)} to="/knowledge"><ArrowLeft aria-hidden="true" data-icon="inline-start" />Back to Knowledge</Link>
      {!capabilities ? <StatePanel state="loading" title="Checking Knowledge availability" detail="Reading the process-local capability boundary." />
        : capabilities.wiki.read.availability === "unavailable" ? <StatePanel state="unavailable" title="Knowledge unavailable" detail={capabilities.wiki.read.reason ?? "The Wiki reader is unavailable."} />
          : (detail.isPending || workspacePending) && !visibleResponse ? <StatePanel state="loading" title="Opening Knowledge record" detail="Reading the bounded body and safe evidence projection from one indexed revision." />
            : detail.isError && !visibleResponse ? <WikiProblem error={detail.error} retry={() => void detail.refetch()} />
              : revisionConflict && !visibleResponse ? <StatePanel action={<Button disabled={detail.isFetching || relationPage.isFetching || backlinkPage.isFetching} onClick={() => void reloadLatest()} size="sm" type="button" variant="outline">Reload latest</Button>} state="error" title="Knowledge changed while opening" detail="The body and link panels did not belong to one indexed revision, so none of them were displayed." />
              : visibleResponse ? (
                <>
                  <header className={styles.detailHeader} ref={headerRef} tabIndex={-1}>
                    <div><p className={styles.detailEyebrow}>{visibleResponse.entity.kind} · Knowledge record</p><h1>{visibleResponse.entity.title}</h1>{visibleResponse.entity.summary ? <p className={styles.detailSummary}>{visibleResponse.entity.summary}</p> : null}</div>
                    <div className={styles.detailStatus}><StatusPill tone={healthTone(visibleResponse.entity.groundingHealth)}>{sentenceCase(visibleResponse.entity.groundingHealth)}</StatusPill><StatusPill>Revision {visibleResponse.indexedRevision.slice(0, 8)}</StatusPill></div>
                  </header>
                  {revisionConflict ? <div className={styles.revisionConflict} role="alert"><RefreshCw aria-hidden="true" /><span><strong>Knowledge changed while this record was open.</strong>The current body and links remain frozen until every panel reloads from one revision.</span><Button disabled={detail.isFetching || relationPage.isFetching || backlinkPage.isFetching} onClick={() => void reloadLatest()} size="sm" type="button" variant="outline">Reload latest</Button></div> : null}
                  {needsReview(visibleResponse.entity.groundingHealth) ? <div className={styles.partialNotice} role="status"><AlertTriangle aria-hidden="true" /><span><strong>The linked code changed since this record was checked.</strong>Run <code>mex check</code> to see which links, and <code>mex sync</code> to review the record.</span></div> : null}
                  {partial ? <div className={styles.partialNotice} role="status"><AlertTriangle aria-hidden="true" /><span><strong>This is a bounded or partial projection.</strong>Trustworthy content is retained; omitted evidence and independent link failures are called out in place.</span></div> : null}
                  <div className={styles.detailGrid}>
                    <DetailIdentity detail={visibleResponse} />
                    <section aria-label="Knowledge body and links" className={styles.detailStack}>
                      <Card className={styles.workspaceCard} size="sm">
                        <CardHeader><CardTitle><h2>Record body</h2></CardTitle><CardAction><Badge variant="secondary">{visibleResponse.body.totalBytes.toLocaleString()} bytes</Badge></CardAction></CardHeader>
                        <CardContent className={styles.bodyCardContent}>
                          {visibleResponse.body.content ? <article aria-label="Knowledge body as plain text" className={styles.bodyArticle} tabIndex={0}>{visibleResponse.body.content}</article> : <StatePanel compact state="empty" title="No body recorded" detail="This indexed record has metadata but no body text." />}
                          {visibleResponse.body.truncated ? <p className={styles.bodyBound}>Body stopped at the 128 KiB response boundary. Canonical content was not changed.</p> : null}
                        </CardContent>
                      </Card>
                      <EdgePanel
                        backlinkCursor={revisionConflict ? null : backlinkCursor}
                        backlinkError={((backlinkPage.isError && !backlinkRecovered) || (backlinkMutationCurrent && loadBacklinks.isError)) && !revisionConflict}
                        backlinkPending={backlinkPage.isPending}
                        backlinkTruncated={backlinkTruncated}
                        backlinks={backlinks}
                        entityId={id}
                        loadingBacklinks={backlinkMutationCurrent && loadBacklinks.isPending}
                        loadingRelations={relationMutationCurrent && loadRelations.isPending}
                        onLoadBacklinks={() => {
                          loadBacklinks.mutate({ entityId: id, indexedRevision: visibleResponse.indexedRevision, cursor: backlinkCursor });
                        }}
                        onLoadRelations={() => {
                          loadRelations.mutate({ entityId: id, indexedRevision: visibleResponse.indexedRevision, cursor: relationCursor });
                        }}
                        relationCursor={revisionConflict ? null : relationCursor}
                        relationError={((relationPage.isError && !relationRecovered) || (relationMutationCurrent && loadRelations.isError)) && !revisionConflict}
                        relationPending={relationPage.isPending}
                        relationTruncated={relationTruncated}
                        relations={relations}
                      />
                    </section>
                    <aside className={styles.contextStack} aria-label="Knowledge evidence and provenance">
                      <Card className={styles.workspaceCard} size="sm">
                        <CardHeader><CardTitle><h2>Code grounding</h2></CardTitle><CardAction><Badge variant="outline">{visibleResponse.groundings.total}</Badge></CardAction></CardHeader>
                        <CardContent className={styles.edgeCardContent}>{visibleResponse.groundings.items.length ? <div className={styles.contextSection}>{visibleResponse.groundings.items.map((grounding, index) => <GroundingRow grounding={grounding} key={`${grounding.requestedNode}-${index}`} />)}</div> : <StatePanel compact state="empty" title="No code grounding" detail="This record does not explicitly point to a code symbol." />}{visibleResponse.groundings.truncated ? <p className={styles.bodyBound}>Additional groundings were omitted.</p> : null}</CardContent>
                      </Card>
                      <Card className={styles.workspaceCard} size="sm">
                        <CardHeader><CardTitle><h2>Evidence</h2></CardTitle><CardAction><Badge variant="outline">{visibleResponse.sources.total}</Badge></CardAction></CardHeader>
                        <CardContent className={styles.edgeCardContent}>{visibleResponse.sources.items.length ? <div className={styles.contextSection}>{visibleResponse.sources.items.map((source, index) => <SourceRow key={`${source.type}-${source.ref}-${index}`} source={source} />)}</div> : <StatePanel compact state="empty" title="No evidence recorded" detail="This record has no bounded source projection." />}{visibleResponse.sources.truncated ? <p className={styles.bodyBound}>Additional sources were omitted.</p> : null}</CardContent>
                      </Card>
                      <Card className={styles.workspaceCard} size="sm">
                        <CardHeader><CardTitle><h2>Provenance</h2></CardTitle></CardHeader>
                        <CardContent>{visibleResponse.provenance ? <dl className={styles.factList}><div><dt>Producer</dt><dd>{sentenceCase(visibleResponse.provenance.kind)}</dd></div><div><dt>Identity</dt><dd className={styles.mono}>{visibleResponse.provenance.id ?? "Not recorded"}</dd></div><div><dt>Captured</dt><dd>{formatDate(visibleResponse.provenance.capturedAt)}</dd></div></dl> : <StatePanel compact state="empty" title="Provenance not recorded" detail="No safe producer identity is available for this entry." />}</CardContent>
                      </Card>
                    </aside>
                  </div>
                </>
              ) : null}
    </div>
  );
}

export function KnowledgePage({ embedded = false }: { embedded?: boolean }) {
  return <KnowledgeBrowse embedded={embedded} />;
}

export function KnowledgeDetailPage() {
  return <KnowledgeDetail />;
}
