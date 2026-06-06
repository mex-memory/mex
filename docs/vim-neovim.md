# Using mex with Vim / Neovim

mex's scaffold is tool-agnostic — any AI plugin that can read a system prompt or config file can use it. This guide covers four common setups.

## 1. Claude Code in Neovim's terminal

Run Claude Code directly inside Neovim. This is the path with the least setup — mex already generates a `CLAUDE.md` that Claude picks up automatically.

```bash
# Inside Neovim:
:term claude
```

Claude Code reads `CLAUDE.md` from the project root, so mex's instructions are applied without any plugin configuration. Run `mex setup` (option 1) once to create `CLAUDE.md`, and you're done.

## 2. Avante.nvim

[Avante.nvim](https://github.com/yetone/avante.nvim) supports a custom system prompt. Point it at `.mex/ROUTER.md` (the file mex uses to route AI tools to the right context):

```lua
require("avante").setup({
  system_prompt = function()
    local f = io.open(vim.fn.getcwd() .. "/.mex/ROUTER.md", "r")
    if not f then return "" end
    local content = f:read("*a")
    f:close()
    return content
  end,
})
```

Run `mex setup` with option 8 (None / other) — this keeps `.mex/` populated without copying a tool-specific config.

## 3. Copilot.vim / copilot.lua

GitHub Copilot for Neovim reads `.github/copilot-instructions.md` automatically. mex already supports this via `setup.sh` option 4:

```bash
./setup.sh
# Choose option 4 when prompted
```

No plugin config required — Copilot picks up the file as soon as it exists.

## 4. Generic LSP / any other plugin

Any plugin that accepts a system prompt can be pointed at `.mex/ROUTER.md`. The pattern:

```lua
-- Read the ROUTER once and pass it in as the system prompt
local mex_prompt = table.concat(vim.fn.readfile(".mex/ROUTER.md"), "\n")
```

Then feed `mex_prompt` into whatever field your plugin exposes (system prompt, instructions, custom context, etc).

If the plugin doesn't take a file, paste this line into its system prompt instead:

```text
Read .mex/ROUTER.md in the current working directory and follow its routing instructions.
```

That one line is enough — mex's ROUTER.md handles the rest.

## Verifying your setup

After any of the above, run:

```bash
mex check
```

If the scaffold is wired up correctly, mex will pick up your project state and show any drift between config files.
