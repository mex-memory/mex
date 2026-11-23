# Add a graph language adapter

Create a folder under `native/engine/langs/` for the adapter and its fixtures.
Add an entry in `langs/registry.toml`.

```toml
[[language]]
id = "example"
folder = "example"
level = "basic"
```

Save the config as `langs/example/example.toml`. Pick a linked grammar.
Available names are `python`, `rust`, `csharp`, `javascript`,
`typescript` and `tsx`.

```toml
grammar = "python"
adapter_version = 1
extensions = [".example"]

[functions]
function_definition = "name"

[classes]
class_definition = "name"

[imports]
import_statement = "name"

[calls]
call = "function"
```

Each key names a tree-sitter node kind. Each value selects its name.
Use `name` for a field, `function.attribute` for nested fields, or `0`
for the first named child. A missing name skips that site.
Leave a table empty when the grammar has no corresponding node.

Build the engine and run `mex-graph languages` to check the entry. Send
a `stage` or `build` request with the id and explicit fixture paths. Verify
the outline, import sites and `basic` call hints. Calls match one exact
declaration name. Imports can also match a file stem. See the
[test fixture](../../native/engine/engine/tests/fixtures/basic/sample/sample.toml)
for a config that reuses Python syntax. The shipped Node CLI discovers its
own supported extensions.

To upgrade to full, add the extractor and resolver code to the adapter's
folder. Register its implementation in the engine and set `level = "full"`.
Keep the adapter config. Add tests that prove scope and import resolution
and protect existing definition ids. Bump `adapter_version` when extraction
or resolution changes, and keep it in sync with the full adapter's Rust
constant.
