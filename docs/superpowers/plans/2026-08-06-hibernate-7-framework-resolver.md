# Hibernate 7 Framework Resolver (Spring Boot 4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fixture-backed `FrameworkResolver` for **Hibernate 7** entity associations and **Spring Data JPA** repository→entity links, active only on **Spring Boot 4.x** projects with Hibernate 7 evidence.

**Architecture:** Third framework resolver beside Express and Spring Boot HTTP/DI. Reuse `isSpringBoot4Project()`. Add Hibernate 7 / JPA detection. Express-style source scan of `.java` for association annotations and repository interface bounds. Emit `references` edges only; no new node/edge kinds, no schema changes.

**Tech Stack:** Existing mex graph seams, Java extractor (already on branch), Vitest, Node ≥22.5.

## Global Constraints

- **Spring Boot major = 4 only** for activation (reuse `spring-boot-detect.ts`).
- **Hibernate major = 7** when version is explicit; reject explicit Hibernate 6.x / 5.x.
- **Jakarta Persistence only** (`jakarta.persistence` / annotation simple names). No `javax.persistence`.
- **MVP edges (locked):** entity associations + Spring Data JPA repos. Not SQL parse, not DDL, not Session API call graph.
- **Frozen seams:** `FrameworkResolver` only; no node-id, schema, reconcile, grounding changes.
- **Vocabulary:** edge kind `references` only. Entity/repo already exist as `class` / `interface` from Java extractor.
- **No guessing:** multi-candidate type names → no edge.
- **Java extractor prerequisite:** must be present; Spring Boot resolver may already be on branch — Hibernate is separate registration, may share detect helpers.
- **Contributor rules:** fixture + focused tests; `docs/code-graph-support.md` claims fixture-bounded.

---

## Context (facts)

### Existing mex graph

| Piece | Status |
|---|---|
| Java extractor | Classes, interfaces, fields, methods, decorators (simple annotation names), package import path resolution |
| Spring Boot 4 resolver | Routes + constructor DI; detect in `spring-boot-detect.ts` |
| Framework registry | `express`, `spring-boot` |
| Shared edge for “depends on type” | `references` (framework provenance `heuristic`) |

Java already stores `@Entity` etc. as `decorators` strings and `decorates` unresolved refs — **not** association target binding or repository type params as framework edges.

### Hibernate 7 + Boot 4 (external)

- Hibernate ORM **7** baselines Java 17, **Jakarta Persistence 3.2**.
- Spring Framework 7 / Boot 4 portfolio targets Hibernate ORM **7.x** as JPA provider.
- Domain annotations for MVP remain standard JPA: `@Entity`, `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany`, plus Spring Data `JpaRepository` / `CrudRepository`.
- Hibernate-removed annotations (`@Where` → `@SQLRestriction`, etc.) are **out of MVP** unless needed for detection.

### Why FrameworkResolver

Plain AST does not mark “this field is an association” vs plain field, or “this interface is a Spring Data repository bound to Entity X”. Framework rules + sole-candidate resolve match Express/Boot pattern.

---

## Design decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| MVP | Associations + Spring Data JPA repos | User pick |
| Activation | Boot 4 **and** Hibernate 7 / JPA-on-Boot4 evidence | User: Hibernate 7 + Boot 4 limit |
| Approach | Express-style regex/source scan in `FrameworkResolver` | Same seam as Boot/Express |
| Entity identity | No synthetic entity node — use existing `class` nodes | YAGNI; Java already extracts class |
| Association edge | Owning **class** → target **class** `references` | Stable ids; field-level optional later |
| Repo edge | **interface** → entity **class** `references` | Type-param bind |
| Collection types | Unwrap `List`/`Set`/`Collection`/`Optional` one level; use type arg | Common Spring Data / JPA shape |

### Approaches considered

1. **FrameworkResolver source scan (recommended)** — detect + extract associations/repos + resolve unique classes. Small blast radius.
2. **Extend Java extractor** — bake JPA into language layer. **Rejected for MVP:** mixes language with library; harder Boot/Hibernate version gating.
3. **New node kinds (`entity`, `repository`)** — clearer UX. **Rejected:** requires vocabulary/schema discussion; `class`/`interface` + `decorators` enough for agents.

### Explicitly deferred

- `@Query` / HQL / Criteria / native SQL parse
- `@EntityGraph`, fetch profiles, `@SQLRestriction`
- `@Embeddable` / `@ElementCollection` graphs
- `mappedBy` inverse-side special casing beyond type edges
- `EntityManager` / `Session` call binding
- Flyway/Liquibase
- Hibernate 6 / Boot 3
- Kotlin
- Multi-module BOM without Boot 4 signal
- Discriminator / inheritance strategy nodes
- Soft `@JoinColumn` name as graph nodes

---

## Detection (concrete)

**Both required:**

```
isSpringBoot4Project(context) && hasHibernate7OnBoot4(context)
```

### `hasHibernate7OnBoot4(text | files)`

Positive (any):

1. Coordinate / dependency with `hibernate-core` or `org.hibernate.orm` and version matching `^7\.` (allow `7.0.10.Final` style).
2. Boot 4 project **and** dependency artifact among:
   - `spring-boot-starter-data-jpa`
   - `spring-boot-starter-data-jpa` modular Boot 4 renames if present in fixture (verify name in Boot 4 BOM; use whatever fixture uses — commonly still `spring-boot-starter-data-jpa` or module equivalent)
   - `hibernate-core` without version when Boot 4 parent/BOM already confirmed
3. Gradle same patterns as Boot detect (plugin already Boot 4; deps lines).

Negative:

- Boot 3 only → false (outer gate).
- Explicit `hibernate-core` / `hibernate-orm` version `6.x` or `5.x` → false even if Boot 4 (strict library pin).
- Spring Data JDBC / R2DBC only, no JPA/Hibernate marker → false.
- No build evidence and no way to see deps → false.

Implement as `src/graph/resolution/frameworks/hibernate-detect.ts` reusing `candidateBuildFiles` patterns from `spring-boot-detect.ts` (import shared file list helper or duplicate thin copy to avoid breaking Boot API — prefer **export** `candidateBuildFiles` / share module if clean).

---

## Extract (concrete)

### A) Entity associations

For each `class` body (same class-span approach as Boot resolver):

1. Class is “entity-like” if header or class-level annotations include `@Entity` (simple name). Skip non-entities for association emit (still allow target to be entity when resolving).
2. Scan fields (and optional property getters later — **MVP fields only**):

```
@ManyToOne ... Type name;
@OneToOne ... Type name;
@OneToMany ... List<Type> name;  // or Set/Collection
@ManyToMany ... Set<Type> name;
```

Also accept annotations on same field with multi-line:

```
@ManyToOne
@JoinColumn(...)
private Order order;
```

3. For each association, emit:

```
UnresolvedRef {
  fromNodeId: generateNodeId(file, "class", OwnerName),
  referenceName: TargetSimpleType,
  referenceKind: "references",
  filePath, language: "java"
}
```

4. Target simple type rules:

- Strip generics: `List<LineItem>` → `LineItem`
- Strip arrays: `Tag[]` → `Tag` (rare for associations)
- Skip primitives/wrappers/`String`/`LocalDate`/etc. (same denylist spirit as Boot DI)
- Skip if type starts lowercase
- `targetEntity = Foo.class` in annotation args **preferred** over field type when present (Hibernate/JPA override)

### B) Spring Data JPA repositories

Match interfaces:

```
public interface WidgetRepository extends JpaRepository<Widget, Long> { }
public interface WidgetRepository extends CrudRepository<Widget, UUID> { }
public interface WidgetRepository extends PagingAndSortingRepository<Widget, Long> { }
public interface WidgetRepository extends ListCrudRepository<Widget, Long> { }
```

MVP super-types (simple name):

- `JpaRepository`
- `CrudRepository`
- `PagingAndSortingRepository`
- `ListCrudRepository`
- `ListPagingAndSortingRepository`

First type argument = entity simple name (after stripping FQCN).

Emit:

```
fromNodeId: generateNodeId(file, "interface", RepoName)
referenceName: EntitySimpleName
referenceKind: "references"
```

Skip if no type args parseable. Multi-extend: first matching Spring Data super-interface wins.

**Do not** require `@Repository` on interface (Spring Data does not always use it).

---

## Resolve (concrete)

```
resolve(ref, context):
  if ref.referenceKind !== "references": return null
  from = getNodeById(ref.fromNodeId)
  if !from: return null
  // only bind framework DI-like refs we emitted (class or interface sources)
  if from.kind not in (class, interface): return null

  candidates = getNodesByName(ref.referenceName)
    .filter(n => n.kind === "class" && n.id !== from.id)

  if candidates.length === 1 → bind confidence 1, resolvedBy framework
  if candidates.length > 1:
    sameDir unique → bind
    else null
  else null
```

Optional enhancement (same PR only if tests cheap): prefer candidates whose decorators include `Entity` when `getNodeById` has decorators loaded — **not required** if sole name unique.

---

## File map

| Path | Role |
|---|---|
| `src/graph/resolution/frameworks/hibernate-detect.ts` | Boot4∧Hibernate7 detection |
| `src/graph/resolution/frameworks/hibernate.ts` | `FrameworkResolver` |
| `src/graph/resolution/frameworks/index.ts` | Register `hibernateResolver` |
| `src/graph/__tests__/fixtures/hibernate-boot4-app/` | pom Boot 4 + hibernate/jpa + entities + repo |
| `src/graph/__tests__/resolver-hibernate-detect.test.ts` | Detection unit tests |
| `src/graph/__tests__/resolver-hibernate.test.ts` | Extract/resolve unit tests |
| `src/graph/__tests__/engine-hibernate.test.ts` | E2E graph persistence |
| `docs/code-graph-support.md` | New section |
| `docs/extractors.md` | One-line note |

Optional small refactor: extract shared `candidateBuildFiles` to `build-file-scan.ts` if duplication hurts — only if touch count stays small.

---

## Fixture (acceptance)

```
hibernate-boot4-app/
  pom.xml                          # parent spring-boot-starter-parent 4.0.0
                                   # spring-boot-starter-data-jpa
  src/main/java/com/example/
    Widget.java                    # @Entity
    Order.java                     # @Entity, @ManyToOne Widget widget
    LineItem.java                  # @Entity, @ManyToOne Order order
    OrderRepository.java           # extends JpaRepository<Order, Long>
```

Expected after `engine.build`:

| Edge | Kind |
|---|---|
| `Order` class → `Widget` class | `references` (framework) |
| `LineItem` class → `Order` class | `references` |
| `OrderRepository` interface → `Order` class | `references` |

Detection negatives:

- Same sources, Boot **3** parent → resolver `detect` false, no framework association edges from this resolver.
- Boot 4 + explicit `hibernate-core` **6.6.x** → detect false.

---

## Tasks

### Task 0: Prerequisites

- [ ] **Step 1:** Confirm Java extractor + Spring Boot detect present; graph tests green for Java/Boot.
- [ ] **Step 2:** Issue via `new_framework_resolver.md`: Framework Hibernate 7; languages java; blocked by Java extractor; Boot 4 gate.
- [ ] **Step 3:** Branch after/on top of Java (+ optional Boot) work; do not mix unrelated refactors.

---

### Task 1: Detection helper (TDD)

**Files:**
- Create: `src/graph/resolution/frameworks/hibernate-detect.ts`
- Create: `src/graph/__tests__/resolver-hibernate-detect.test.ts`

**Interfaces:**
- `hasHibernate7Evidence(text: string): boolean`
- `isHibernate7OnSpringBoot4(context: ResolutionContext): boolean`

- [ ] **Step 1: Failing tests**

```ts
it("accepts Boot 4 pom with starter-data-jpa", () => {
  expect(isHibernate7OnSpringBoot4(ctxWithBoot4AndDataJpa)).toBe(true);
});
it("rejects Boot 3 pom with starter-data-jpa", () => {
  expect(isHibernate7OnSpringBoot4(ctxBoot3)).toBe(false);
});
it("rejects Boot 4 with explicit hibernate-core 6.x", () => {
  expect(isHibernate7OnSpringBoot4(ctxBoot4Hibernate6)).toBe(false);
});
it("accepts explicit hibernate-core 7.x under Boot 4", () => {
  expect(hasHibernate7Evidence(`org.hibernate.orm:hibernate-core:7.0.10.Final`)).toBe(true);
});
```

- [ ] **Step 2: Implement** — call `isSpringBoot4Project` then scan build files for Hibernate/JPA evidence with version rules above.

- [ ] **Step 3: Tests pass; commit**

```bash
git commit -m "feat(graph): detect Hibernate 7 on Spring Boot 4 projects"
```

---

### Task 2: Association extract/resolve (TDD)

**Files:**
- Create: `src/graph/resolution/frameworks/hibernate.ts`
- Modify: `index.ts` register
- Create fixtures entities
- Create: `resolver-hibernate.test.ts`

**Interfaces:**
- `hibernateResolver: FrameworkResolver`
  - `name: "hibernate"`
  - `languages: ["java"]`
  - `detect: isHibernate7OnSpringBoot4`
  - `extract` / `resolve`

- [ ] **Step 1: Fixture** `Order` `@ManyToOne Widget`, both `@Entity`.

- [ ] **Step 2: Failing tests** — extract emits class→`Widget` ref from `Order`; resolve unique class; ambiguous two `Widget` classes → null; non-entity plain field `String name` no emit.

- [ ] **Step 3: Implement association parsing** (fields + `targetEntity`).

- [ ] **Step 4: Pass; commit**

```bash
git commit -m "feat(graph): Hibernate 7 entity association edges"
```

---

### Task 3: Spring Data JPA repository edges (TDD)

**Files:**
- Modify: `hibernate.ts`, fixture `OrderRepository.java`, tests

- [ ] **Step 1: Failing tests** — `JpaRepository<Order, Long>` → interface→`Order`; also `CrudRepository`; ignore raw `interface Foo {}`.

- [ ] **Step 2: Implement** interface extends parse.

- [ ] **Step 3: Pass; commit**

```bash
git commit -m "feat(graph): Spring Data JPA repository to entity edges"
```

---

### Task 4: Engine end-to-end

**Files:**
- Create: `engine-hibernate.test.ts`
- Full fixture tree with pom Boot 4 + data-jpa + 2–3 entities + 1 repo

- [ ] **Step 1: build engine on fixture; assert association + repo edges in SQLite**

```ts
// edges: Order → Widget, OrderRepository → Order, kind references
```

- [ ] **Step 2: optional Boot3 negative engine** (detect off — no route-style assert; count framework association edges = 0 if only this resolver would create them)

- [ ] **Step 3: commit**

```bash
git commit -m "test(graph): Hibernate 7 engine persistence fixture"
```

---

### Task 5: Docs

- [ ] **Step 1: `docs/code-graph-support.md`** — section “Hibernate 7 / Spring Data JPA (Boot 4)” after Spring Boot section; Supported vs Deferred lists from this plan.
- [ ] **Step 2: `docs/extractors.md`** — third framework example one-liner.
- [ ] **Step 3: commit**

```bash
git commit -m "docs: Hibernate 7 code-graph framework support"
```

---

### Task 6: Full verify

```bash
npm run typecheck
npm test
npm run build
```

All green. Manual optional:

```bash
node dist/cli.js graph --root src/graph/__tests__/fixtures/hibernate-boot4-app --json
sqlite3 .../graph.db "SELECT s.name, t.name FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target WHERE e.kind='references' LIMIT 20;"
```

---

## Risk notes

| Risk | Mitigation |
|---|---|
| Boot 4 starter artifact rename | Detect Boot 4 + `data-jpa` / `hibernate` tokens; fixture uses real Boot 4 coords |
| Lombok / records entities | MVP plain fields; document skip |
| Association on getter (property access) | Deferred; field access fixtures only |
| Generic `JpaRepository<T, ID>` in intermediate base interface | Deferred; direct extends only |
| Collision with Spring Boot DI `references` edges | Same edge kind OK; different fromNode kinds; agents care about endpoints |
| False Hibernate 7 via Boot 4 alone without JPA | Require data-jpa or hibernate marker |

---

## Out of scope

- Changing Java extractor for annotation arguments
- New edge kinds (`associates`, `persists`)
- Hibernate 6 / Boot 3 mode
- Full ORM metamodel

---

## Execution order

```
Task 0  prereq / issue
Task 1  detect Boot4 ∧ Hibernate7
Task 2  entity associations
Task 3  Spring Data repos
Task 4  engine e2e
Task 5  docs
Task 6  verify
```

## Spec coverage

| Requirement | Task |
|---|---|
| Boot 4 only | 1 |
| Hibernate 7 (explicit 6 reject) | 1 |
| Associations | 2, 4 |
| Spring Data JPA repos | 3, 4 |
| Fixture docs | 5 |
| No schema/identity change | all |
