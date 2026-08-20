<div align="center">

<img src="mascot/mex-mascot.svg" alt="mex 吉祥物" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="MEX ASCII 标志" width="520">

**由 AI 编程代理维护的代码库动态 Wiki。**

[English](README.md) | **简体中文** | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md)

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/badge/stars-1.2K%2B-111111)](https://github.com/mex-memory/mex/stargazers)
[![Website](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VG7ySSMQM)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/node-%3E%3D22.5-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#代理记忆模式)
[![MCP](https://img.shields.io/badge/MCP-compatible-6f8cff)](#mcp-服务器)

</div>

---

mex 为代码建立地图，把代理学到的知识整理成结构化 Markdown，并让这些知识始终连接到它所描述的实现。

每次编程会话都从相关的架构上下文开始，而不是重新扫描整个仓库。

> **v0.7.2 新功能：** 一次调用即可获得带源码的图谱检索、由编译器解析的 TypeScript 执行流、确定性证据以及严格的输出预算。

💬 **加入 mex Discord 社区** — 讨论想法、获取帮助、分享反馈并参与项目贡献。

[加入 Discord →](https://discord.gg/VG7ySSMQM)

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="mex 项目记忆操作面板" width="640">
</p>

## 你的代码库知道的远比文档更多

架构、约定、边界情况和历史决策散落在源代码、Pull Request、聊天记录以及每位贡献者的脑海中。

AI 编程代理会在每次会话中重新发现这些知识。一个巨大的指令文件起初可能有用，但它最终会挤占上下文窗口、逐渐过时，并与真实实现脱节。

mex 创建一个位于仓库内、持续演进的 Wiki，并随代理的工作不断成长：

- 代理把学到的知识写成可读的 Markdown
- 确定性代码图谱将知识连接到精确的代码符号
- 基于任务的路由只加载当前工作需要的上下文
- 漂移检查找出可能受代码变更影响的知识
- 工作完成后，决策、模式和当前项目状态会被写回 Wiki

代码仍然是真实来源，Wiki 则成为由代理持续维护的解释层。

| 普通项目文档 | mex 动态 Wiki |
|---|---|
| 写完一次后逐渐被遗忘 | 从真实的编程工作中持续成长 |
| 与实现脱节 | 声明可以指向精确的代码符号 |
| 以一个巨大指令文件整体加载 | 根据任务路由上下文 |
| 重构会悄悄让文档失效 | 检测已变更、移动或消失的符号 |
| 每个代理都重新理解架构 | 代理继承已有发现和决策 |
| 知识在会话之间丢失 | 决策和可复用模式保留在仓库中 |

## 工作原理

### 1. 为代码库建立地图

mex 使用 Tree-sitter 和 SQLite 构建确定性的本地代码图谱。它索引 TypeScript、TSX、JavaScript、JSX、Python 和 Rust 中的符号及关系，并支持识别 Express 路由到处理器的框架级关系。

```bash
mex graph
```

### 2. 构建 Wiki

设置过程中，编程代理使用图谱理解项目，并填充结构化的 Markdown Wiki：

```text
.mex/
├── AGENTS.md
├── ROUTER.md
├── context/
│   ├── architecture.md
│   ├── stack.md
│   ├── setup.md
│   ├── decisions.md
│   └── conventions.md
├── patterns/
│   ├── INDEX.md
│   └── ...
└── events/
    └── decisions.jsonl
```

这些都是普通的 Markdown 文件：人类和代理都能阅读、审查、版本控制和编辑。

### 3. 路由正确的上下文

代理从一个很小的锚点文件开始，而不是加载整个 Wiki。锚点指向 `ROUTER.md`，由它选择当前任务相关的架构说明、决策、约定和任务模式。

```text
代理任务
    ↓
始终加载的小型锚点
    ↓
ROUTER.md
    ↓
相关 Wiki 页面
    ↓
紧凑的代码图谱邻域
    ↓
按需展开源代码
```

![mex 上下文路由流程](docs/diagrams/context-routing.svg)

可编辑源文件：[docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

### 4. 持续保持更新

完成有意义的工作后，代理会更新项目状态、记录决策并提炼可复用模式。mex 检查 Wiki 是否仍与仓库一致：

```bash
mex check
mex sync
```

`mex check` 无需消耗 AI token 即可验证路径、命令、依赖、链接、索引、时效性、工具配置和锚定的代码符号。需要修复时，`mex sync` 会向代理提供定向上下文，无需重新理解整个项目。

![mex 漂移检测与同步循环](docs/diagrams/drift-sync.svg)

可编辑源文件：[docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## 锚定于代码

Wiki 页面可以把重要声明连接到精确的图谱节点。行为声明可以通过 frontmatter 进行锚定：

```yaml
---
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
---
```

关键符号引用也可以在正文中直接导航：

```markdown
身份验证由
[`requireSession()`](mex://function:a3f8...c21) 执行。
```

当函数发生变化、移动或消失时，mex 可以找到受影响的知识。同步时，可信的重命名和移动会被重新绑定；不确定的变化则交由代理判断。

这样，代理可以广泛阅读以理解行为，同时只锚定真正支撑其声明的少量符号。

## 面向编程代理的紧凑检索

代码图谱同时也是一个紧凑的代理检索层：

```bash
mex graph scope "追踪身份验证流程"
```

mex 不会返回整个仓库，而是在严格的估算 token 预算内优先返回最可能回答任务的声明和真实执行流。默认响应包含源码，并使用确定性的 `meta`、`source`、`flow` 和 `summary` JSONL 记录。

返回的源码应视为已经阅读。当摘要状态为 `ok` 时，即使低优先级的可选上下文被截断，代理也可以直接作答。仅在缺少某个声明或摘要建议继续时才需要精确展开：

```bash
mex graph get <node-id>
```

还可以直接执行结构查询和影响分析：

```bash
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph query what-calls createServer
mex impact requireSession
```

面向代理的图谱命令使用确定性的 JSONL 信封，使工具能够可靠地区分元数据、结果和摘要。

## 测试结果

一项包含 24 个会话的试验，在 12 个 Hono 和 MEX 任务上比较了 0.7.2 候选版本与仅文件搜索：

| 指标 | 结果 |
|---|---:|
| 盲审正确答案 | **候选版本 7/12，对照组 6/12** |
| 新增 token 变化 | **-54.5%** |
| 处理 token 变化 | **-72.5%** |
| 估算成本变化 | **-56.6%** |
| 平均延迟变化 | **-22.9%** |
| 返回的必需源码区间 | **22/23（95.7%）** |
| 返回的 Hono 必需执行流 | **6/6（100%）** |

每个任务都使用 Claude Sonnet 为每个方案运行一次。这是一项小样本描述性试验，对照组仅搜索文件；它既不是与已发布 `main` 的比较，也不能证明普遍的 token 节省。方法和限制详见[基准测试报告](evaluate/RESULTS.md)。

请参阅[基准测试结果](evaluate/RESULTS.md)和[评估工具](evaluate/README.md)，了解方法、原始结果、局限及复现命令。

## 快速开始

mex 需要 Node.js 22.5 或更高版本。npm 包名为 `mex-agent`，因为 `mex` 已被占用；CLI 命令仍然是 `mex`。

```bash
npx mex-agent setup
```

设置会扫描仓库、构建本地代码图谱、创建 Markdown Wiki、让编程代理依据图谱证据填充内容、安装对应的项目锚点，并验证结果。

设置完成后：

```bash
mex check                    # 检查 Wiki 健康状况和代码锚定
mex sync                     # 使用定向代理提示修复漂移
mex graph scope "<task>"     # 检索紧凑的任务上下文
```

如果未全局安装，请使用 `npx mex-agent` 代替 `mex`。也可以随时全局安装：

```bash
npm install -g mex-agent
```

### Windows

推荐的 `npx mex-agent setup` 流程可直接在命令提示符、PowerShell 或 WSL 中运行，无需 bash。

如果使用旧版 `setup.sh` 流程，请在同一个环境中执行安装、构建和 CLI 命令。不要在 WSL 中构建后再从 Windows 原生终端运行 CLI。背景信息见 [issue #10](https://github.com/mex-memory/mex/issues/10)。

## 核心命令

所有命令都在项目根目录运行。如果没有全局安装，请将 `mex` 替换为 `npx mex-agent`。

| 命令 | 作用 |
|---|---|
| `mex` / `mex tui` | 打开交互式终端面板 |
| `mex setup` | 创建并填充动态 Wiki |
| `mex check` | 检查 Wiki 健康状况并计算漂移分数 |
| `mex sync` | 修复过时或不一致的知识 |
| `mex graph` | 构建或刷新本地代码图谱 |
| `mex graph scope <task>` | 检索紧凑的任务相关上下文 |
| `mex graph get <node-id...>` | 展开检索结果中的精确符号 |
| `mex graph query <relation> <symbol>` | 查询结构化代码关系 |
| `mex graph ground` | 将已有的 0.7 之前 Wiki 连接到图谱 |
| `mex impact <symbol\|file>` | 查找受代码变更影响的代码和 Wiki 内容 |
| `mex log <message>` | 记录决策、笔记、风险或待办 |
| `mex timeline` | 查看最近的项目事件 |
| `mex heartbeat` | 运行持久代理健康检查 |
| `mex completion <shell>` | 输出 shell 补全脚本 |
| `mex commands` | 列出所有命令和脚本 |

## 已有 mex 项目

在 mex 0.7 之前创建的项目可以添加图谱锚定，而无需重新生成或改写现有文档：

```bash
mex graph
mex graph ground
```

迁移代理会保留现有文本，同时添加精确的 `grounds_to` 条目和可导航的 `mex://` 引用，并且可以安全地重复运行。

现有安装仍然兼容。没有图谱时，文件系统和词法检查器会继续运行。如果 SQLite 或某个语法无法加载，图谱检查会显示警告并跳过，CLI 的其余功能仍然可用。

请参阅[代码图谱支持](docs/code-graph-support.md)，了解经过测试的语言与关系矩阵、优雅降级行为和当前限制。

## 支持的工具

`mex setup` 会为你的编程代理安装对应的项目锚点：

| 工具 | 项目锚点 |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |

Neovim 用户可以参考 [Neovim 集成指南](docs/vim-neovim.md)，其中包括 Claude Code、Avante.nvim、Copilot.vim 和通用插件的配置方式。

## MCP 服务器

`packages/mex-mcp` 通过 Model Context Protocol 工具公开现有 Wiki 与事件日志功能，并复用与 CLI 相同的实现。

MCP 包尚未发布。本地开发时请运行：

```bash
npm run build --workspace mex-mcp
```

v0.7.2 的主要发布内容仍然是 `mex-agent` CLI。

## 代理记忆模式

mex 的主要体验是代码库动态 Wiki。同样的路由和维护模型也可用于以运维环境为“项目”的持久代理：

```bash
mex setup --mode agent-memory
```

代理记忆模式为家庭实验室、基础设施工作区和长期运行的运维代理添加 `HEARTBEAT.md` 协议与清理约定。

在社区成员对 OpenClaw 的独立测试中，mex 通过了 10/10 个结构化家庭实验室场景，平均减少约 60% 的加载上下文。这些结果描述的是代理记忆模式，与上面的代码图谱基准测试相互独立。

## 设计理念

- **Markdown 是持久接口。** 人类和代理都能阅读和编辑。
- **代码是真实来源。** 重要声明始终连接到实现。
- **上下文应该路由，而不是倾倒。** 代理只加载任务需要的内容。
- **知识应从真实工作中成长。** 有用的模式来自已完成的任务。
- **维护应持续进行。** 文档随仓库一起演进。
- **检索应具有确定性。** 机械性工作不应消耗 AI token。

## 遥测

mex 收集匿名、可选择退出的使用数据——命令名称、版本和操作系统——以了解工具的使用方式。它绝不会收集路径、参数、文件内容、IP 地址或个人数据。

使用 `mex telemetry inspect` 审查确切的数据载荷。可通过 `DO_NOT_TRACK=1`、`MEX_TELEMETRY=0` 或 `mex config set telemetry off` 退出。详情见 [TELEMETRY.md](TELEMETRY.md)。

## 生态系统

mex 不绑定任何供应商。集成指南、赞助示例和社区方案应当本身有用、明确标注，并放在文档中，而不是悄悄改变默认体验。

## 参与贡献

欢迎贡献。开发设置和贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 更新日志

发布历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
