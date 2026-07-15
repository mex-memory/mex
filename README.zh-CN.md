<!-- Translated from README.md at commit: 735e38a -->

<div align="center">

<img src="mascot/mex-mascot.svg" alt="Mex 吉祥物" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="MEX ASCII 标志" width="520">

<h1 align="center">Mex：面向 AI 编程代理的项目记忆层</h1>

**为 AI 编程代理提供持久化的项目记忆。**

[English](README.md) | **简体中文** | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md)

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/badge/stars-1.2K%2B-111111)](https://github.com/theDakshJaitly/mex/stargazers)
[![Website](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VG7ySSMQM)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](README.md)
[![MCP](https://img.shields.io/badge/MCP-compatible-6f8cff)](#mcp-服务器)

</div>

---

AI 编程代理会在会话之间遗忘一切。Mex 为它们提供持久、可导航的项目记忆，让每次会话都能从正确的项目上下文开始，而不是面对一大段毫无头绪的提示。它帮助代理理解代码库、保留决策，并通过结构化的开发者工具保持记忆与真实代码同步。

> **发布状态：** npm 和 `main` 目前仍为稳定版 v0.6.3。基于 AST/Tree-sitter 的代码图谱位于 `code-graph-preview`，是尚未发布的 v0.7.0 开发者预览版；目前尚未发布到 npm。

💬 **加入 Mex Discord 社区** — 讨论想法、获取帮助、分享反馈并参与项目贡献。

[加入 Discord →](https://discord.gg/VG7ySSMQM)

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="Mex 项目记忆操作面板" width="640">
</p>

## 为什么选择 Mex？

大多数代理记忆方案最终都会变成一个庞大的指令文件。短期内这或许可行，但随后它会挤占上下文窗口、浪费 token，并逐渐偏离真实代码库。

| 不使用 Mex | 使用 Mex |
|-------------|----------|
| 庞大的 `CLAUDE.md` / 规则文件 | 小型锚点文件与按需路由的上下文 |
| 代理会忘记决策和约定 | 决策、模式和项目状态得以保留 |
| 文档悄然偏离代码 | `mex check` 可发现过时或损坏的脚手架声明 |
| 每次会话都从零开始 | 代理只加载与当前任务有关的文件 |
| 重复工作依赖口口相传 | 可复用模式从真实任务中持续积累 |

## Mex 的作用

Mex 为代理记忆创建结构化的 Markdown 脚手架：

- `AGENTS.md` / `CLAUDE.md` — 由工具自动加载的小型锚点文件
- `ROUTER.md` — 将任务路由到特定上下文的路由表
- `context/` — 架构、技术栈、配置、决策和约定
- `patterns/` — 包含注意事项与验证步骤的可复用任务指南
- `.mex/events/decisions.jsonl` — 通过 `mex log` 追加记录的笔记

CLI 会确保这套脚手架保持可靠。它无需消耗 AI token，即可检查路径、命令、依赖项、模式索引、陈旧程度和脚本覆盖率。当出现漂移时，`mex sync` 会生成有针对性的提示，让代理只修复过时的部分。

## 快速开始

npm 当前稳定版本为 v0.6.3。请使用 Node.js 20 或更高版本安装：

npm 包名为 `mex-agent`，因为 `mex` 已被占用。CLI 命令仍然是 `mex`。

```bash
npx mex-agent setup
```

如需测试代码图谱预览版或参与贡献，请使用 Node.js 22.5 或更高版本，并从源码构建 `code-graph-preview`：

```bash
git clone https://github.com/theDakshJaitly/mex.git
cd mex
git switch code-graph-preview
npm install
npm run build
```

安装流程会创建 `.mex/` 脚手架，询问你使用哪种 AI 工具，预扫描代码库，并生成有针对性的提示来填充记忆文件。整个过程大约需要五分钟。

安装结束时，你可以全局安装 Mex：

```bash
mex check        # 漂移评分
mex sync         # 修复漂移
```

如果跳过全局安装，请使用 npx：

```bash
npx mex-agent check
npx mex-agent sync
```

你也可以随时在之后进行全局安装：

```bash
npm install -g mex-agent
```

### Windows

推荐的 `npx mex-agent setup` 流程可在任意终端中运行（命令提示符、PowerShell 或 WSL），且不需要 bash，因此大多数 Windows 用户无需特别处理本节内容。

> **Windows 用户（旧版 `setup.sh` 流程）：** 请在 WSL 或 Git Bash 中运行所有命令，不要混用环境。

如果你之前通过旧版 `setup.sh` 脚本安装，在 WSL 中构建后又从 Windows 原生终端运行 CLI，会因两个文件系统之间的 `node_modules` 和路径解析差异而出现“module not found”错误。请在同一环境内完成安装、构建和 CLI 命令：要么全部使用 WSL / Git Bash，要么全部在 Windows 原生环境中通过 `npx mex-agent` 完成。

背景信息请参阅 [issue #10](https://github.com/theDakshJaitly/mex/issues/10)。

## 工作原理

![Mex 上下文路由流程](docs/diagrams/context-routing.svg)

代理从一个自动加载的小文件开始。该文件指向 `ROUTER.md`，路由器只加载当前任务所需的上下文。完成有意义的工作后，GROW 步骤会更新项目状态、决策和任务模式，让脚手架随着使用不断变得更有价值。

可编辑源文件：[docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

## 漂移检测

十一个检查器会根据真实代码库验证脚手架。零 token，零 AI。

| 检查器 | 检测内容 |
|---------|----------|
| **path** | 磁盘上不存在的引用文件路径 |
| **edges** | 指向缺失文件的 YAML frontmatter 边目标 |
| **index-sync** | `patterns/INDEX.md` 与实际模式文件不同步 |
| **staleness** | 超过 30 天或 50 次提交未更新的脚手架文件 |
| **command** | 引用了不存在脚本的 `npm run X` / `make X` |
| **dependency** | `package.json` 中缺失的声明依赖项 |
| **cross-file** | 不同文件对同一依赖项声明了不同版本 |
| **script-coverage** | 未在任何脚手架文件中提及的 `package.json` 脚本 |
| **tool-config-sync** | 已安装 AI 工具的配置文件（如 `CLAUDE.md`、`.cursorrules`）彼此不同步 |
| **todo-fixme** | 脚手架 Markdown 中尚未处理的 `TODO` / `FIXME` 标记 |
| **broken-link** | 指向磁盘上不存在文件的本地 Markdown 链接 |

评分从 100 开始。每个错误扣 10 分，每个警告扣 3 分，每条信息扣 1 分。

![Mex 漂移检测与同步循环](docs/diagrams/drift-sync.svg)

可编辑源文件：[docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## 命令

所有命令都从项目根目录运行。如果未全局安装，请将 `mex` 替换为 `npx mex-agent`。

| 命令 | 作用 |
|------|------|
| `mex` | 打开交互式终端面板 |
| `mex tui` | 显式打开交互式终端面板 |
| `mex setup` | 首次设置：创建 `.mex/` 脚手架并使用 AI 填充 |
| `mex setup --mode agent-memory` | 为持久代理 / 家庭实验室记忆工作区创建模板 |
| `mex setup --dry-run` | 预览设置操作，但不实际修改 |
| `mex check` | 运行漂移检查器并输出评分报告 |
| `mex check --quiet` | 单行输出：`mex: drift score 92/100 (1 warning)` |
| `mex check --json` | 以 JSON 输出完整报告 |
| `mex check --fix` | 检查并在发现错误后直接进入同步 |
| `mex sync` | 检测漂移、选择模式、让 AI 修复、验证并重复 |
| `mex sync --dry-run` | 预览定向提示，但不执行 |
| `mex sync --warnings` | 在同步中包含仅有警告的文件 |
| `mex init` | 预扫描代码库并为 AI 构建结构化摘要 |
| `mex init --json` | 原始扫描器摘要 JSON |
| `mex log <message>` | 追加笔记、决策、风险或待办事项 |
| `mex timeline` | 查看最近的事件日志条目 |
| `mex heartbeat` | 运行一次轻量级持久代理健康检查 |
| `mex doctor` | 显示易读的脚手架健康摘要 |
| `mex watch` | 安装 post-commit hook |
| `mex watch --interval` | 在前台重复运行 heartbeat |
| `mex watch --uninstall` | 移除 hook |
| `mex completion <shell>` | 输出 shell 补全 |
| `mex commands` | 列出命令、脚本及其说明 |

## 支持的工具

`mex setup` 会询问你使用的工具，并创建相应的配置文件。

| 工具 | 配置文件 |
|------|----------|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |
| Codex | `AGENTS.md` |

Neovim 用户可以参阅 [docs/vim-neovim.md](docs/vim-neovim.md)，了解 Claude Code、Avante.nvim、Copilot.vim 和通用插件的配置方法。

## MCP 服务器

`packages/mex-mcp` 通过 [Model Context Protocol](https://modelcontextprotocol.io) 将 Mex 以原生工具调用形式提供给 AI 代理，无需启动 shell，并返回结构化 JSON。它直接导入 `mex-agent`，因此工具与 CLI 运行相同代码，永远不会产生功能偏差。

| 工具 | 对应的 CLI | 返回内容 |
|------|------------|----------|
| `mex_check` | `mex check --json` | 漂移报告：评分、问题和已检查文件 |
| `mex_log` | `mex log` / `mex timeline` | 追加事件（`decision`/`note`/`risk`/`todo`）或读取近期事件 |
| `mex_timeline` | `mex timeline` | 按类型/日期筛选的事件，最新优先 |
| `mex_heartbeat` | `mex heartbeat` | 健康检查：陈旧文件和待执行的记忆清理 |
| `mex_read_file` | — | 脚手架文件内容，限制在 `.mex/` 中 |

每个工具都接受可选的 `projectRoot`（默认使用当前目录），因此一个服务器可以面向任意项目。请先运行 `mex setup`，这些工具需要 `.mex/` 脚手架。

配置客户端（Claude Code / Cursor 的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "mex": {
      "command": "node",
      "args": ["packages/mex-mcp/dist/index.js"]
    }
  }
}
```

请先使用 `npm run build --workspace mex-mcp` 构建。发布后，配置将变为 `"command": "npx", "args": ["mex-mcp"]`。

会话开始时，代理通过两个调用进行定向：

```
mex_check()                   # 脚手架是否正在漂移？
mex_read_file("ROUTER.md")    # 加载路由器，然后只读取所需上下文
```

## 使用前后对比

以下是 Mex 在 AI 驱动的农业语音帮助热线 Agrow 上测试时的真实输出。

**设置前的脚手架：**

```markdown
## Current Project State
<!-- What is working. What is not yet built. Known issues.
     Update this section whenever significant work is completed. -->
```

**设置后的脚手架：**

```markdown
## Current Project State

**Working:**
- Voice call pipeline (Twilio -> STT -> LLM -> TTS -> response)
- Multi-provider STT with configurable selection
- RAG system with Supabase pgvector
- Streaming pipeline with barge-in support

**Not yet built:**
- Admin dashboard for call monitoring
- Automated test suite
- Multi-turn conversation memory across calls

**Known issues:**
- Sarvam AI STT bypass active; ElevenLabs fallback in use
```

**设置后的模式目录：**

```text
patterns/
├── add-api-client.md
├── add-language-support.md
├── debug-pipeline.md
└── add-rag-documents.md
```

## 真实场景结果

一位社区成员在 **OpenClaw** 上独立进行了测试，覆盖 Ubuntu 24.04、Kubernetes、Docker、Ansible、Terraform、网络和监控等 10 个结构化家庭实验室场景。10/10 项测试全部通过，漂移评分为 100/100。

| 场景 | 不使用 Mex | 使用 Mex | 节省 |
|------|------------|----------|------|
| “K8s 如何工作？” | ~3,300 tokens | ~1,450 tokens | 56% |
| “开放 UFW 端口” | ~3,300 tokens | ~1,050 tokens | 68% |
| “解释 Docker” | ~3,300 tokens | ~1,100 tokens | 67% |
| 多上下文查询 | ~3,300 tokens | ~1,650 tokens | 50% |

**每次会话平均减少约 60% 的 token。**

## 代理记忆模式

`mex setup --mode agent-memory` 为持久代理创建脚手架。这类代理的“项目”是一个运行环境，而不是代码仓库。该模式会添加 `HEARTBEAT.md` 约定和模板，将 Mex 作为结构化、按任务路由的记忆：

- `ROUTER.md` 跟踪当前运行状态，并将代理路由到正确的记忆文件。
- `context/` 存储架构、技术栈、约定、设置和决策。
- `patterns/` 存储重复使用的运行手册。
- `.mex/events/decisions.jsonl` 通过 `mex log` 存储只追加的笔记和决策依据。

`mex heartbeat` 有意设计得比 `mex check` 更轻量：它读取 `last_updated` frontmatter 和记忆清理元数据，状态正常时输出 `HEARTBEAT_OK`，仅在代理需要检查陈旧上下文或记忆文件时报告。使用 `mex watch --interval` 可在持久代理工作区中重复运行 heartbeat。

## 配置

可选设置位于 `.mex/config.json`。缺失的值将使用默认配置。

```json
{
  "staleness": {
    "warnDays": 30,
    "errorDays": 90,
    "warnCommits": 50,
    "errorCommits": 200
  },
  "heartbeat": {
    "staleDays": 7,
    "memoryCleanupDays": 7,
    "dailyMemoryRetentionDays": 14
  },
  "watch": {
    "intervalMinutes": 30
  }
}
```

## 遥测

Mex 会收集匿名且可退出的使用数据（命令名称、版本和操作系统，但绝不会收集路径、参数、文件内容、IP 或个人数据），用于了解产品的使用方式。可通过 `mex telemetry inspect` 审核实际载荷，并随时使用 `DO_NOT_TRACK=1`、`MEX_TELEMETRY=0` 或 `mex config set telemetry off` 退出。完整说明请参阅 [TELEMETRY.md](TELEMETRY.md)。

## 生态系统

Mex 不依赖特定提供商。集成指南、赞助示例和社区方案本身应具备实用价值，并应清晰标注且放在文档中，而不是悄然改变默认体验。

## 参与贡献

欢迎贡献。设置方法和贡献指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 更新日志

发布历史请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
