# Code graph support

This page documents the fixture-backed code-graph support shipped in mex v0.7.0.

This page distinguishes three evidence levels:

- **Supported** — implemented and exercised by a focused fixture and test.
- **Partial** — wired into the release, but not independently fixture-tested for
  every listed extension or syntax family.
- **Unsupported** — no grammar and extractor are registered in this release.

## Language and file support

The extension and grammar mappings live in
[`src/graph/extraction/grammars.ts`](../src/graph/extraction/grammars.ts), and the
extractor registry lives in
[`src/graph/extraction/languages/index.ts`](../src/graph/extraction/languages/index.ts).

| Status | Language | Extensions | Current evidence |
|---|---|---|---|
| **Supported** | TypeScript | `.ts` | [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts), [`typescript-edge-cases.ts`](../src/graph/__tests__/fixtures/typescript-edge-cases.ts), and their focused tests exercise declarations, calls, imports, visibility, async functions, and type shapes. |
| **Partial** | TypeScript modules | `.mts`, `.cts` | Both extensions map to the TypeScript grammar and extractor, but the current `sample.ts` fixture does not exercise them separately. |
| **Supported** | TSX | `.tsx` | [`tsx-component.tsx`](../src/graph/__tests__/fixtures/tsx-component.tsx) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, interfaces, imports, and calls. |
| **Supported** | JavaScript | `.js` | [`javascript-edge-cases.js`](../src/graph/__tests__/fixtures/javascript-edge-cases.js) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover classes, static methods, construction, calls, and resilient parsing. |
| **Partial** | JavaScript modules | `.mjs`, `.cjs` | Both extensions map to the JavaScript grammar and extractor, but they are not exercised by dedicated fixtures. |
| **Supported** | JSX | `.jsx` | [`jsx-component.jsx`](../src/graph/__tests__/fixtures/jsx-component.jsx) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, imports, calls, and construction. |
| **Supported** | Python | `.py` | [`sample.py`](../src/graph/__tests__/fixtures/sample.py), [`extractor-python.test.ts`](../src/graph/__tests__/extractor-python.test.ts), and the [`python-package`](../src/graph/__tests__/fixtures/python-package) integration fixture cover extraction and cross-file package resolution. |
| **Supported** | Rust | `.rs` | [`sample.rs`](../src/graph/__tests__/fixtures/sample.rs) and [`extractor-rust.test.ts`](../src/graph/__tests__/extractor-rust.test.ts) cover structs, traits, enums, modules, functions, methods, generics, imports, calls, implementations, construction, returns, and field types. |
| **Supported** | Java | `.java` | [`sample.java`](../src/graph/__tests__/fixtures/sample.java), [`module-info.java`](../src/graph/__tests__/fixtures/module-info.java), [`extractor-java.test.ts`](../src/graph/__tests__/extractor-java.test.ts), and the [`java-package`](../src/graph/__tests__/fixtures/java-package) engine fixture cover classes, interfaces, enums, records, annotation types, nested types, constructors, fields, packages, imports (including static and star), extends/implements, calls, instantiations, method references, module-info, Javadoc, and package-path cross-file resolution. |
| **Unsupported** | Go and other languages | All other extensions | These names may be reserved in [`src/graph/types.ts`](../src/graph/types.ts), but no grammar or extractor is registered for them. Unsupported files are skipped rather than failing a graph build. |

`src/graph/types.ts` contains a wider future-facing language vocabulary. A name
in that type union is not a support promise; the grammar and extractor
registries above are the current sources of truth.

## Fixture-backed extraction

The core TypeScript fixture contains an import, an exported function, a class, methods,
a callable field, a property, a constant, inheritance, interface
implementation, calls, and construction:

```ts
import { formatName } from "./helpers";

const PREFIX = "hello";

export function greet(name: string): string {
  return formatName(name);
}

export class Greeter extends Base implements Speaker {
  greeting = PREFIX;
  speak(name: string): string {
    const w = new Warmup();
    return greet(name);
  }
}
```

[`extractor.test.ts`](../src/graph/__tests__/extractor.test.ts) proves the
following output from [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts):

| Output | Fixture-backed behavior |
|---|---|
| Nodes | `file`, `function`, `class`, `method`, `property`, and `constant` |
| Symbol metadata | exported state, function signature, docstring, and qualified method name |
| Relationships | `contains`, `imports`, `calls`, `extends`, `implements`, and `instantiates` |

The complete shared vocabulary in
[`src/graph/types.ts`](../src/graph/types.ts) includes additional node and edge
kinds for current internals and future extractors. Kinds not named in the table
above are not claimed as fixture-backed TypeScript behavior by this page.

The shared TypeScript-family walker and regression fixtures cover
`interface`, `enum`, `enum_member`, `type_alias`, and top-level `variable`
nodes in
[`src/graph/extraction/languages/typescript.ts`](../src/graph/extraction/languages/typescript.ts).
The Express fixture separately proves the framework-specific `route` node and
resolved `references` relationship below.

## Express route resolution

Express is the only framework resolver included in v0.7.0. It activates
when `express` appears in `dependencies` or `devDependencies`, recognizes a
literal route registered through `app` or `router`, emits a `route` node, and
links an identifier handler when it can resolve that handler confidently.

```ts
import express from "express";

const app = express();
export function healthHandler(): void {}
app.get("/health", healthHandler);
```

[`express-app.ts`](../src/graph/__tests__/fixtures/express-app.ts) and
[`resolver-express.test.ts`](../src/graph/__tests__/resolver-express.test.ts)
prove detection, the `GET /health` route node, the `healthHandler` reference,
and same-file handler binding. The end-to-end persistence path is covered by
the “activates the Express resolver and links a route to its handler” case in
[`engine.test.ts`](../src/graph/__tests__/engine.test.ts).

This resolver does not promise general framework or dynamic-dispatch analysis.
Computed route strings, inline callbacks, handler arrays, middleware chains,
and registrations hidden behind arbitrary helper functions are outside the
fixture-backed shape. NestJS and Next.js resolvers are not included.

## Spring Boot 4 route and constructor-injection resolution

Spring Boot is the second framework resolver. It activates only when project
build files evidence **Spring Boot 4.x** (Maven `pom.xml` and/or Gradle
`build.gradle` / `build.gradle.kts` / `libs.versions.toml`). Boot 3.x and
versionless Spring Framework-only projects do not activate the resolver.

It emits `route` nodes from mapping annotations and `references` edges from
controller classes to constructor-injected types when binding is unambiguous.

```java
@RestController
@RequestMapping("/api")
public class WidgetController {
  public WidgetController(WidgetService service) { ... }

  @GetMapping("/widgets")
  public String list() { ... }
}
```

[`spring-boot-app`](../src/graph/__tests__/fixtures/spring-boot-app) plus
[`resolver-spring-boot.test.ts`](../src/graph/__tests__/resolver-spring-boot.test.ts)
and [`engine-spring-boot.test.ts`](../src/graph/__tests__/engine-spring-boot.test.ts)
prove Boot 4 detection (and Boot 3 rejection), the `GET /api/widgets` route node,
route→handler binding, and `WidgetController`→`WidgetService` constructor
injection when the target class is unique.

**Supported (fixture-backed):**

- Detection via Boot 4 parent/BOM/plugin/coordinates (Maven and Gradle)
- `@GetMapping` / `@PostMapping` / `@PutMapping` / `@PatchMapping` /
  `@DeleteMapping` / `@RequestMapping` with string path literals
- Class-level `@RequestMapping` path composition
- Route → controller method (`references`)
- Single-constructor injection and `@Autowired` / `@Inject` constructors →
  unique `class` target

**Deferred:** field/setter injection, `@Bean` methods, WebFlux functional routes,
Kotlin, Boot 3, `@Qualifier`, multi-candidate type names, path constants, SpEL.

## Hibernate 7 / Spring Data JPA (Spring Boot 4)

Hibernate is the third framework resolver. It activates only when the project is
**Spring Boot 4.x** and build files evidence **Hibernate 7** or
`spring-boot-starter-data-jpa` (Boot-managed). Explicit Hibernate **6.x** / **5.x**
pins disable the resolver even on Boot 4.

It emits `references` edges from:

- `@Entity` classes with association fields (`@ManyToOne`, `@OneToOne`,
  `@OneToMany`, `@ManyToMany`) to the target entity class type; and
- Spring Data repository interfaces (`JpaRepository`, `CrudRepository`, …)
  to the entity type argument.

```java
@Entity
public class Order {
  @ManyToOne
  private Widget widget;
}

public interface OrderRepository extends JpaRepository<Order, Long> {}
```

[`hibernate-boot4-app`](../src/graph/__tests__/fixtures/hibernate-boot4-app),
[`resolver-hibernate.test.ts`](../src/graph/__tests__/resolver-hibernate.test.ts),
and [`engine-hibernate.test.ts`](../src/graph/__tests__/engine-hibernate.test.ts)
prove Boot4+data-jpa detection, Boot3 rejection, Hibernate 6 pin rejection,
`Order`→`Widget` / `LineItem`→`Order` associations, and
`OrderRepository`→`Order` binding when the target class is unique.

**Supported (fixture-backed):**

- Detection: Boot 4 ∧ (data-jpa starter or hibernate-core 7.x)
- Field associations with collection unwrap (`List`/`Set`/`Collection`)
- `targetEntity = Foo.class` override
- `JpaRepository` / `CrudRepository` / `PagingAndSortingRepository` /
  `ListCrudRepository` / `ListPagingAndSortingRepository`

**Deferred:** `@Query`/HQL parse, embeddables, Session/EntityManager call
binding, property-access getters, Kotlin, Boot 3, Hibernate 6, intermediate
generic base repository interfaces.

## Graceful degradation

The code graph requires Node.js 22.5 or newer because it uses the built-in
`node:sqlite` module. There is no alternate database fallback.

When the graph database or SQLite capability is unavailable:

- setup warns and continues without the code graph (see
  [`src/setup/index.ts`](../src/setup/index.ts));
- ordinary filesystem and lexical drift checks continue while grounding checks
  are skipped with a warning (see
  [`src/drift/index.ts`](../src/drift/index.ts)); and
- graph query/scope commands return a machine-readable `GRAPH_UNAVAILABLE`
  error instead of inventing results.

These paths are covered by the “scope degrades” and “graph loading fails” cases
in [`graph-cli-agent.test.ts`](../test/graph-cli-agent.test.ts) and the “keeps
legacy checks running” case in
[`graph-integration.test.ts`](../test/graph-integration.test.ts).

Unsupported source-language files are also skipped. A missing extractor does
not make the rest of setup or drift checking fail.

## Known limitations

- **Ambiguous references stay unresolved.** The base resolver prefers a
  same-file definition, an unambiguous imported definition, a sole candidate,
  or a unique exported candidate. Otherwise it emits no edge rather than
  guessing; see
  [`src/graph/resolution/resolver.ts`](../src/graph/resolution/resolver.ts).
- **Dynamic dispatch is not general-purpose.** Tree-sitter extraction and the
  narrow Express resolver cover statically recognizable shapes, not runtime
  reflection, dependency injection, monkey-patching, or computed calls.
- **Generated code is path-filtered, not identified semantically.** Common
  output trees such as `node_modules`, `dist`, `build`, `.next`, `out`,
  `coverage`, and `.mex` are excluded by the source globs in
  [`engine-impl.ts`](../src/graph/engine-impl.ts) and
  [`runtime.ts`](../src/graph/runtime.ts). Generated files outside those paths
  may still be indexed.
- **Framework behavior is opt-in and narrow.** Express route-to-handler binding,
  Spring Boot 4 route + constructor-injection edges, and Hibernate 7 entity
  association + Spring Data JPA repository edges (Boot 4 only) are the
  fixture-backed framework resolvers. Other frameworks remain unsupported until
  their language extractor and resolver work merges.
- **Java overload and constructor identity are coarse.** Tier-1 node ids use
  `kind` + `name` only, so overloaded methods collapse and constructors share
  the synthetic name `<init>` (same limitation class as other languages).
- **Java package resolution is path-suffix only.** Imports bind when an indexed
  file path ends with `com/foo/Bar.java` for `com.foo.Bar`. Platform packages
  (`java.*`, `javax.*`, `jakarta.*`, …), jars, and multi-module source-root
  heuristics are outside the fixture-backed shape.
- **Support claims are fixture-bounded.** This page describes behavior exercised
  by the current release fixtures. It does not promise complete semantic analysis
  for every construct in a supported language or support for unmerged Go, NestJS,
  or Next.js work.

For contributor interfaces, fixture requirements, and registration points, see
[Extending the code graph](extractors.md).
