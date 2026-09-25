// Shared fixture repositories and edit kinds for the refresh oracle (issue
// #209): the differential tests replay the edits, and the checker-order
// property test builds the trees.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Files = Record<string, string>;

export interface Edit {
  name: string;
  apply(root: string): void;
  /** A refresh that must refuse and leave both stores untouched. */
  refuses?: boolean;
  /** The refresh strategy a correct implementation must report. */
  expectMode?: "incremental" | "full";
}

export interface Fixture {
  name: string;
  files: Files;
  edits: Edit[];
  /** A framework resolver the fixture must exercise. */
  framework?: boolean;
}

export function writeTree(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function write(path: string, content: string): Edit["apply"] {
  return (root) => writeTree(root, { [path]: content });
}

export function remove(path: string): Edit["apply"] {
  return (root) => rmSync(join(root, path));
}

export function append(path: string, content: string): Edit["apply"] {
  return (root) => writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + content);
}

export function replace(path: string, from: string, to: string): Edit["apply"] {
  return (root) => {
    const before = readFileSync(join(root, path), "utf8");
    if (!before.includes(from)) throw new Error(`Fixture edit did not match ${path}: ${from}`);
    writeFileSync(join(root, path), before.replace(from, to));
  };
}

export function all(...steps: Edit["apply"][]): Edit["apply"] {
  return (root) => { for (const step of steps) step(root); };
}

export function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const TS_FIXTURE: Fixture = {
  name: "typescript",
  files: {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src"],
    }, null, 2),
    "package.json": JSON.stringify({ name: "fixture-ts", type: "module" }, null, 2),
    "src/globals.d.ts": "declare global {\n  interface AppInfo { version: string }\n  var appInfo: AppInfo;\n}\nexport {};\n",
    "src/ambient.d.ts": "declare module \"virtual:config\" {\n  export const flag: boolean;\n}\n",
    "src/util/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function scale(value: number, factor: number): number {\n  return value * factor;\n}\n",
    "src/util/format.ts": "export function format(value: number): string {\n  return value.toFixed(2);\n}\n",
    "src/util/index.ts": "export * from \"./math\";\nexport { format } from \"./format\";\n",
    "src/service.ts": "import { add, format } from \"./util\";\nimport { flag } from \"virtual:config\";\n\nexport class Service {\n  total(a: number, b: number): string {\n    return flag ? format(add(a, b)) : \"\";\n  }\n}\n",
    "src/main.ts": "import { Service } from \"./service\";\n\nexport function run(): string {\n  return new Service().total(1, 2) + appInfo.version;\n}\n",
    "src/helpers.ts": "export function helper(input: string): string {\n  return input.trim();\n}\n",
    "src/consumer.ts": "import { helper } from \"./helpers\";\n\nexport function useHelper(): string {\n  return helper(\" value \");\n}\n",
    "src/standalone.ts": "export function lonely(): number {\n  return 42;\n}\n",
    "src/bulk.ts": Array.from({ length: 8 }, (_, index) =>
      `export function bulk${index}(value: number): number {\n  const doubled = value * ${index + 2};\n  return doubled + ${index};\n}\n`).join("\n"),
    "src/bulk-user.ts": "import { bulk0, bulk1 } from \"./bulk\";\n\nexport function useBulk(): number {\n  return bulk0(1) + bulk1(2);\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/util/format.ts", "// trailing comment\n"), expectMode: "incremental" },
    { name: "rename function", apply: all(
      replace("src/util/math.ts", "export function scale(", "export function multiply("),
    ), expectMode: "incremental" },
    { name: "change an import", apply: replace("src/consumer.ts", "import { helper } from \"./helpers\";", "import { helper } from \"./helpers2\";"), expectMode: "incremental" },
    { name: "add file", apply: write("src/helpers2.ts", "export function helper(input: string): string {\n  return input.toUpperCase();\n}\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("src/shadow.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n"), expectMode: "incremental" },
    { name: "move function between files", apply: all(
      replace("src/util/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n", ""),
      append("src/util/format.ts", "\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n"),
    ), expectMode: "incremental" },
    { name: "delete file", apply: remove("src/standalone.ts"), expectMode: "incremental" },
    // Many nodes and fingerprints disappear at once, and an importer whose
    // content is unchanged loses the targets of its bindings and calls.
    { name: "delete a file with many declarations", apply: remove("src/bulk.ts"), expectMode: "incremental" },
    { name: "remove same-named definition in another file", apply: remove("src/shadow.ts"), expectMode: "incremental" },
    { name: "revert import", apply: replace("src/consumer.ts", "from \"./helpers2\"", "from \"./helpers\""), expectMode: "incremental" },
    { name: "change the ambient declaration", apply: replace("src/globals.d.ts", "version: string", "version: string;\n    build: number"), expectMode: "full" },
    // Neither field decides what the compiler resolves, so both are no-ops.
    { name: "change an insignificant tsconfig option", apply: replace("tsconfig.json", "\"strict\": true", "\"strict\": false") },
    { name: "rename the package", apply: replace("package.json", "\"fixture-ts\"", "\"fixture-ts-renamed\"") },
    { name: "change tsconfig", apply: replace("tsconfig.json", "\"target\": \"ES2022\"", "\"target\": \"ES2020\""), expectMode: "full" },
    { name: "change package.json", apply: replace("package.json", "\"type\": \"module\"", "\"type\": \"module\",\n  \"imports\": { \"#util\": \"./src/util/index.ts\" }"), expectMode: "full" },
    { name: "file stops parsing", apply: write("src/helpers.ts", "export function helper(input: string): string {\n  return input.trim(\n}}}} ((( [[[ export const = ;\n"), refuses: true },
    // Not the last published bytes, or the refresh after the refusal is a no-op.
    { name: "file parses again", apply: write("src/helpers.ts", "export function helper(input: string): string {\n  return input.trim().toLowerCase();\n}\n"), expectMode: "incremental" },
    { name: "branch-switch batch", apply: all(
      write("src/util/math.ts", "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n\nexport function scale(value: number, factor: number): number {\n  return value * factor;\n}\n"),
      write("src/feature/index.ts", "import { scale } from \"../util/math\";\n\nexport function feature(): number {\n  return scale(2, 3);\n}\n"),
      write("src/feature/extra.ts", "import { feature } from \"./index\";\n\nexport const extra = feature();\n"),
      remove("src/helpers2.ts"),
      replace("src/consumer.ts", "return helper(\" value \");", "return helper(\" branch \");"),
    ) },
  ],
};

export const JS_FIXTURE: Fixture = {
  name: "javascript",
  files: {
    "lib/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "lib/index.js": "import { add } from \"./math.js\";\n\nexport function total(values) {\n  return values.reduce((sum, value) => add(sum, value), 0);\n}\n",
    "lib/legacy.cjs": "const { total } = require(\"./total.cjs\");\n\nfunction legacy() {\n  return total([1, 2]);\n}\n\nmodule.exports = { legacy };\n",
    "lib/total.cjs": "function total(values) {\n  return values.length;\n}\n\nmodule.exports = { total };\n",
    "lib/consumer.js": "import { helper } from \"./helper.js\";\n\nexport function consume() {\n  return helper();\n}\n",
    "lib/helper.js": "export function helper() {\n  return 1;\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("lib/math.js", "// note\n"), expectMode: "incremental" },
    { name: "rename function", apply: all(
      replace("lib/math.js", "export function add(", "export function sum("),
      replace("lib/index.js", "import { add } from", "import { sum as add } from"),
    ), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("lib/other.js", "export function helper() {\n  return 2;\n}\n"), expectMode: "incremental" },
    { name: "change a require", apply: replace("lib/legacy.cjs", "require(\"./total.cjs\")", "require(\"./total2.cjs\")") },
    { name: "add required file", apply: write("lib/total2.cjs", "function total(values) {\n  return values.length * 2;\n}\n\nmodule.exports = { total };\n") },
    { name: "delete file", apply: remove("lib/other.js"), expectMode: "incremental" },
  ],
};

export const PYTHON_FIXTURE: Fixture = {
  name: "python",
  files: {
    "pkg/__init__.py": "",
    "pkg/a.py": "def helper():\n    return 1\n\n\ndef other():\n    return helper()\n",
    "pkg/b.py": "from pkg.a import helper\n\n\ndef use():\n    return helper()\n\n\ndef bare():\n    return shared()\n",
    "pkg/c.py": "class Widget:\n    def render(self):\n        return 'w'\n",
  },
  edits: [
    { name: "trailing comment", apply: append("pkg/a.py", "# trailing\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: append("pkg/c.py", "\n\ndef helper():\n    return 3\n\n\ndef shared():\n    return 4\n"), expectMode: "incremental" },
    { name: "rename function", apply: replace("pkg/a.py", "def other():", "def another():"), expectMode: "incremental" },
    { name: "move function between files", apply: all(
      replace("pkg/c.py", "\n\ndef shared():\n    return 4\n", ""),
      append("pkg/b.py", "\n\ndef shared():\n    return 5\n"),
    ), expectMode: "incremental" },
    { name: "remove same-named definition in another file", apply: replace("pkg/c.py", "\n\ndef helper():\n    return 3\n", ""), expectMode: "incremental" },
    { name: "add file", apply: write("pkg/d.py", "from pkg.c import Widget\n\n\ndef make():\n    return Widget().render()\n"), expectMode: "incremental" },
    { name: "delete file", apply: remove("pkg/d.py"), expectMode: "incremental" },
  ],
};

export const RUST_FIXTURE: Fixture = {
  name: "rust",
  files: {
    "src/lib.rs": "pub mod a;\npub mod b;\n\npub fn root() -> u32 {\n    b::use_it()\n}\n",
    "src/a.rs": "pub fn helper() -> u32 {\n    1\n}\n",
    "src/b.rs": "use crate::a::helper;\n\npub fn use_it() -> u32 {\n    helper()\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/a.rs", "// trailing\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("src/c.rs", "pub fn helper() -> u32 {\n    2\n}\n"), expectMode: "incremental" },
    { name: "change an import", apply: replace("src/b.rs", "use crate::a::helper;", "use crate::c::helper;"), expectMode: "incremental" },
    { name: "revert", apply: replace("src/b.rs", "use crate::c::helper;", "use crate::a::helper;"), expectMode: "incremental" },
    { name: "delete file", apply: remove("src/c.rs"), expectMode: "incremental" },
  ],
};

export const EXPRESS_FIXTURE: Fixture = {
  name: "express",
  framework: true,
  files: {
    "package.json": JSON.stringify({ name: "fixture-express", dependencies: { express: "^5.0.0" } }, null, 2),
    "handlers.ts": "export function listUsers(): string {\n  return \"users\";\n}\n\nexport function health(): string {\n  return \"ok\";\n}\n",
    "routes.ts": "import express from \"express\";\nimport { listUsers, health } from \"./handlers\";\n\nconst app = express();\napp.get(\"/users\", listUsers);\napp.get(\"/health\", health);\n\nexport default app;\n",
  },
  edits: [
    { name: "trailing comment", apply: append("handlers.ts", "// trailing\n"), expectMode: "incremental" },
    { name: "add route", apply: replace("routes.ts", "app.get(\"/health\", health);", "app.get(\"/health\", health);\napp.post(\"/users\", listUsers);"), expectMode: "incremental" },
    { name: "rename handler", apply: all(
      replace("handlers.ts", "export function health()", "export function status()"),
      replace("routes.ts", "import { listUsers, health }", "import { listUsers, status as health }"),
    ), expectMode: "incremental" },
    { name: "add same-named handler in another file", apply: write("more.ts", "export function listUsers(): string {\n  return \"more\";\n}\n"), expectMode: "incremental" },
    { name: "delete file", apply: remove("more.ts"), expectMode: "incremental" },
  ],
};

export const CSHARP_FIXTURE: Fixture = {
  name: "csharp",
  files: {
    "src/MathUtil.cs": "namespace App\n{\n    public static class MathUtil\n    {\n        public static int Add(int a, int b)\n        {\n            return a + b;\n        }\n    }\n}\n",
    "src/Service.cs": "namespace App\n{\n    public class Service\n    {\n        public int Total()\n        {\n            return MathUtil.Add(1, 2);\n        }\n    }\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/MathUtil.cs", "// trailing\n") },
    { name: "rename method", apply: all(
      replace("src/MathUtil.cs", "public static int Add(", "public static int Sum("),
      replace("src/Service.cs", "MathUtil.Add(1, 2)", "MathUtil.Sum(1, 2)"),
    ) },
    { name: "add same-named definition in another file", apply: write("src/Other.cs", "namespace App\n{\n    public static class Helpers\n    {\n        public static int Sum(int a, int b)\n        {\n            return a - b;\n        }\n    }\n}\n") },
    { name: "add file", apply: write("src/Report.cs", "namespace App\n{\n    public class Report\n    {\n        public int Build()\n        {\n            return new Service().Total();\n        }\n    }\n}\n") },
    { name: "delete file", apply: remove("src/Other.cs") },
  ],
};

export const FASTAPI_FIXTURE: Fixture = {
  name: "fastapi",
  framework: true,
  files: {
    "app/__init__.py": "",
    "app/handlers.py": "def list_users():\n    return []\n\n\ndef health():\n    return 'ok'\n",
    "app/main.py": "from fastapi import FastAPI\nfrom app.handlers import list_users, health\n\napp = FastAPI()\n\n\n@app.get('/users')\ndef users():\n    return list_users()\n\n\n@app.get('/health')\ndef check():\n    return health()\n",
  },
  edits: [
    { name: "trailing comment", apply: append("app/handlers.py", "# trailing\n") },
    { name: "add route", apply: append("app/main.py", "\n\n@app.post('/users')\ndef create_user():\n    return list_users()\n") },
    { name: "rename handler", apply: all(
      replace("app/handlers.py", "def health():", "def status():"),
      replace("app/main.py", "import list_users, health", "import list_users, status as health"),
    ) },
    { name: "add same-named handler in another file", apply: write("app/more.py", "def list_users():\n    return ['more']\n") },
    { name: "delete file", apply: remove("app/more.py") },
  ],
};

export const FLASK_FIXTURE: Fixture = {
  name: "flask",
  framework: true,
  files: {
    "web/__init__.py": "",
    "web/views.py": "def render_index():\n    return 'index'\n",
    "web/app.py": "from flask import Flask\nfrom web.views import render_index\n\napp = Flask(__name__)\n\n\n@app.route('/')\ndef index():\n    return render_index()\n",
  },
  edits: [
    { name: "trailing comment", apply: append("web/views.py", "# trailing\n") },
    { name: "add route", apply: append("web/app.py", "\n\n@app.route('/about')\ndef about():\n    return render_index()\n") },
    { name: "rename view", apply: all(
      replace("web/views.py", "def render_index():", "def render_home():"),
      replace("web/app.py", "import render_index", "import render_home as render_index"),
    ) },
    // Detection is by import: the resolver disappears and returns.
    { name: "remove the only flask import", apply: replace("web/app.py", "from flask import Flask\n", "") },
    { name: "restore the flask import", apply: replace("web/app.py", "from web.views import", "from flask import Flask\nfrom web.views import") },
  ],
};

export const NESTJS_FIXTURE: Fixture = {
  name: "nestjs",
  framework: true,
  files: {
    "package.json": JSON.stringify({ name: "fixture-nest", dependencies: { "@nestjs/common": "^10.0.0", "@nestjs/core": "^10.0.0" } }, null, 2),
    "src/users.service.ts": "export class UsersService {\n  all(): string[] {\n    return [];\n  }\n}\n",
    "src/users.controller.ts": "import { Controller, Get } from \"@nestjs/common\";\nimport { UsersService } from \"./users.service\";\n\n@Controller(\"users\")\nexport class UsersController {\n  constructor(private readonly users: UsersService) {}\n\n  @Get()\n  list(): string[] {\n    return this.users.all();\n  }\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/users.service.ts", "// trailing\n"), expectMode: "incremental" },
    { name: "add route", apply: replace("src/users.controller.ts", "  @Get()\n", "  @Get(\"count\")\n  count(): number {\n    return this.users.all().length;\n  }\n\n  @Get()\n"), expectMode: "incremental" },
    { name: "rename service method", apply: all(
      replace("src/users.service.ts", "all(): string[]", "everyone(): string[]"),
      replace("src/users.controller.ts", "this.users.all()", "this.users.everyone()"),
    ), expectMode: "incremental" },
    { name: "add controller", apply: write("src/health.controller.ts", "import { Controller, Get } from \"@nestjs/common\";\n\n@Controller(\"health\")\nexport class HealthController {\n  @Get()\n  check(): string {\n    return \"ok\";\n  }\n}\n"), expectMode: "incremental" },
    { name: "delete controller", apply: remove("src/health.controller.ts"), expectMode: "incremental" },
  ],
};

export const NEXT_FIXTURE: Fixture = {
  name: "next",
  framework: true,
  files: {
    "package.json": JSON.stringify({ name: "fixture-next", dependencies: { next: "^15.0.0" } }, null, 2),
    "lib/users.ts": "export function listUsers(): string[] {\n  return [];\n}\n",
    "app/api/users/route.ts": "import { listUsers } from \"../../../lib/users\";\n\nexport async function GET(): Promise<Response> {\n  return Response.json(listUsers());\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("lib/users.ts", "// trailing\n"), expectMode: "incremental" },
    { name: "add method", apply: append("app/api/users/route.ts", "\nexport async function POST(): Promise<Response> {\n  return Response.json(listUsers());\n}\n"), expectMode: "incremental" },
    { name: "rename helper", apply: all(
      replace("lib/users.ts", "export function listUsers()", "export function allUsers()"),
      replace("app/api/users/route.ts", "import { listUsers } from", "import { allUsers as listUsers } from"),
    ), expectMode: "incremental" },
    { name: "add route file", apply: write("app/api/health/route.ts", "export async function GET(): Promise<Response> {\n  return new Response(\"ok\");\n}\n"), expectMode: "incremental" },
    { name: "delete route file", apply: remove("app/api/health/route.ts"), expectMode: "incremental" },
  ],
};

/**
 * Checker output that depends on the order types were created in (issue #209):
 * unions the checker orders by internal type id, calls on union-typed
 * receivers and callees, literal unions created in different files, overloads,
 * generics, inferred returns, declaration merging and a re-export chain.
 */
export const ORDER_FIXTURE: Fixture = {
  name: "checker-order",
  files: {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src"],
    }, null, 2),
    "src/shapes.ts": "export class Circle {\n  constructor(readonly radius: number) {}\n  area(): number {\n    return Math.PI * this.radius ** 2;\n  }\n  describe(prefix?: string): string {\n    return `${prefix ?? \"\"}circle`;\n  }\n}\n\nexport class Square {\n  constructor(readonly side: number) {}\n  area(): number {\n    return this.side ** 2;\n  }\n  describe(): string {\n    return \"square\";\n  }\n}\n\nexport type Shape = Circle | Square;\nexport type Mode = \"fast\" | \"safe\" | \"exact\";\n",
    // Each uses one member of the Shape union, so which file the checker
    // visits first decides which class type it creates first.
    "src/squares.ts": "import { Square } from \"./shapes\";\n\nexport function unitSquare(): Square {\n  return new Square(1);\n}\n",
    "src/circles.ts": "import { Circle } from \"./shapes\";\n\nexport function unitCircle(): Circle {\n  return new Circle(1);\n}\n",
    // A mapped type lists its properties in the type-id order of its keys;
    // key-order.ts creates the same key literals in another order.
    "src/records.ts": "export interface Binding {\n  id: string;\n  file: string;\n  line: number;\n  target: string;\n}\n\nexport function retarget(bindings: Binding[]) {\n  return bindings.map((binding) => ({ ...(binding as Omit<Binding, \"target\">), target: \"moved\" }));\n}\n",
    "src/key-order.ts": "export const keys: Array<\"target\" | \"line\" | \"file\" | \"id\"> = [\"target\", \"line\", \"file\", \"id\"];\n",
    "src/literals-a.ts": "export function pickA(flag: boolean): \"exact\" | \"fast\" {\n  return flag ? \"exact\" : \"fast\";\n}\n",
    "src/literals-b.ts": "export function pickB(flag: boolean): \"safe\" | \"exact\" {\n  return flag ? \"safe\" : \"exact\";\n}\n",
    "src/render.ts": "import { Circle, Square, type Mode, type Shape } from \"./shapes\";\n\nexport function label(shape: Shape): string {\n  return shape.describe();\n}\n\nexport function show(value: number | Date | undefined): string | undefined {\n  return value?.toString();\n}\n\nexport function build(kind: \"circle\" | \"square\"): Shape {\n  return kind === \"circle\" ? new Circle(1) : new Square(1);\n}\n\nexport const inferred = (n: number) => (n > 0 ? \"positive\" : n < 0 ? -1 : null);\n\nexport function modeOf(fast: boolean): Mode {\n  return fast ? \"fast\" : \"safe\";\n}\n",
    "src/overloads.ts": "export function parse(value: string): number;\nexport function parse(value: number): string;\nexport function parse(value: string | number): string | number {\n  return typeof value === \"string\" ? Number(value) : String(value);\n}\n\nexport function use(): [number, string] {\n  return [parse(\"1\"), parse(2)];\n}\n",
    "src/generics.ts": "export function mapAll<T, U>(items: readonly T[], fn: (item: T) => U): U[] {\n  return items.map(fn);\n}\n\nexport function lengths(words: string[]) {\n  return mapAll(words, (word) => word.length);\n}\n\nexport function either<A, B>(a: A, b: B): A | B {\n  return Math.random() > 0.5 ? a : b;\n}\n\nexport const mixed = either(1, \"one\");\n",
    "src/merging.ts": "export interface Settings {\n  name: string;\n}\n\nexport interface Settings {\n  level: 1 | 2 | 3;\n}\n\nexport namespace Settings {\n  export const defaults: Settings = { name: \"default\", level: 1 };\n}\n\nexport function level(settings: Settings): 1 | 2 | 3 {\n  return settings.level;\n}\n",
    "src/callbacks.ts": "type Runner = ((task: () => void) => void) | ((task: () => void, delay?: number) => void);\n\nexport function schedule(runner: Runner): void {\n  runner(() => {\n    work();\n  });\n}\n\nfunction work(): void {}\n\ntype Handler = ((value: string) => number) | ((value: string, extra?: boolean) => number);\n\nexport function handle(handler: Handler): number {\n  return handler(\"value\");\n}\n",
    "src/index.ts": "export * from \"./render\";\nexport { parse } from \"./overloads\";\nexport * as gen from \"./generics\";\nexport { level, Settings } from \"./merging\";\n",
    "src/app.ts": "import { build, gen, label, level, parse, Settings, show } from \"./index\";\nimport { pickA } from \"./literals-a\";\nimport { pickB } from \"./literals-b\";\n\nexport function main(): string {\n  const shape = build(\"square\");\n  return [label(shape), show(parse(\"3\")), gen.lengths([\"a\"]).join(), level(Settings.defaults), pickA(true), pickB(false)].join(\" \");\n}\n",
  },
  edits: [
    { name: "change a union-receiver call", apply: replace("src/render.ts", "return shape.describe();", "return shape.describe() + shape.area();"), expectMode: "incremental" },
    { name: "add a member to a union", apply: append("src/shapes.ts", "\nexport class Triangle {\n  describe(suffix?: number): string {\n    return `triangle${suffix ?? \"\"}`;\n  }\n  area(): number {\n    return 1;\n  }\n}\n"), expectMode: "incremental" },
    { name: "widen a literal union", apply: replace("src/literals-b.ts", "\"safe\" | \"exact\"", "\"safe\" | \"exact\" | \"fast\""), expectMode: "incremental" },
    { name: "add an overload", apply: replace("src/overloads.ts", "export function parse(value: number): string;\n", "export function parse(value: number): string;\nexport function parse(value: boolean): boolean;\n"), expectMode: "incremental" },
  ],
};

export const FIXTURES = [
  TS_FIXTURE, ORDER_FIXTURE, JS_FIXTURE, PYTHON_FIXTURE, RUST_FIXTURE, CSHARP_FIXTURE,
  EXPRESS_FIXTURE, FASTAPI_FIXTURE, FLASK_FIXTURE, NESTJS_FIXTURE, NEXT_FIXTURE,
];
