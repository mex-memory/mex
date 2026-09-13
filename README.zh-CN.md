<div align="center">

<h1 id="mex">
  <img src="docs/diagrams/readme/banner.svg" alt="MEX" width="1200">
</h1>

**让工程师与编程智能体共享项目记忆。**

MEX 将团队的架构、决策、需求和交接信息与代码放在一起。工程师及其智能体可以利用共享上下文开展工作、审阅变更提案，并在不同会话和队友之间接续工作——通过 Git 进行共享。

[English](README.md) | **简体中文** | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md)

[![npm 版本](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm 下载量](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub 星标](https://img.shields.io/github/stars/mex-memory/mex?style=flat)](https://github.com/mex-memory/mex/stargazers)
[![网站](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/FEdNsQ4Qt4)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mex-memory/mex/blob/v0.8.0/LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![智能体记忆](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#agent-memory-mode)
[![MCP：仅提供源码](https://img.shields.io/badge/MCP-source%20only-6f8cff)](#mcp-server)

[团队记忆](#what-your-team-remembers) · [队友交接示例](#from-one-engineer-to-the-next) · [Project Hub](#project-hub) · [快速开始](#quick-start) · [工作原理](#how-mex-works) · [命令速查](#command-map)

</div>

> 此译文的主要产品介绍仍对应 0.8.0。安装命令和升级指引已调整为 0.8.2；产品变更请参阅[英文 README](README.md)和 [0.8.2 发行说明](RELEASE_NOTES.md)。

---

一位工程师知道某条约束为何存在，另一位掌握着调试过程中的来龙去脉。编程智能体发现了一个重要的边界情况，却留在了别人不会再读的会话里。下一位队友只好重新拼凑这些信息。

**一位工程师及其智能体获得的认识，应该成为下一位队友能用上的上下文。** MEX 在仓库中为这些知识提供持久的归宿：可读的 Markdown、关联代码的说明、经过审阅的 Spec 提案，以及结构化交接。人通过本地 Hub 浏览和审阅；智能体通过项目指令和 CLI 检索并协助维护。

> [!IMPORTANT]
> **[MEX 0.8](https://github.com/mex-memory/mex/releases/tag/v0.8.0) 将智能体记忆扩展为团队记忆：** 本地 Project Hub、结构化 Wiki 与团队工作流、受审批流程管控的 Specs、Members、Workstreams、Relays、Activity，以及官方 Claude Code/Codex 技能——全部与已有的 Code Graph、代码关联和漂移检测系统相连接。

💬 **加入 Discord 上的 MEX 社区**——讨论想法、寻求帮助、分享反馈，展示你正在构建的项目。

[加入 Discord →](https://discord.gg/FEdNsQ4Qt4)

<a id="what-your-team-remembers"></a>

## 团队需要记住什么

| 团队需要保留的信息 | 在 MEX 中的位置 |
| --- | --- |
| 系统如何工作，以及为什么这样设计 | Wiki 中的架构、决策、约定和模式，并通过 Code Graph 关联代码依据 |
| 产品必须满足什么要求 | Specs、需求、约束和验收标准；通过 Inbox 提案管控变更 |
| 下一位工程师应从哪里继续 | Relays，包含进展、决策、阻碍、证据和下一步行动 |
| 某个工作领域的相关上下文 | Workstreams 及其记录的状态 |
| 谁参与其中，以及 MEX 记录了什么 | Members 和 Activity 历史 |

![工程师及其智能体通过 Git 贡献共享团队记忆。队友及其智能体在独立的检出目录中复用这些记忆，并拥有各自的本地索引。](docs/diagrams/readme/git-sharing.svg)

作为权威记录的记忆文件通过常规 Git 提交、推送和拉取进行共享。每位队友各自保留本地索引、草稿、身份选择和 Hub。无需托管式 MEX 服务、Docker、代理、MEX 账户，也无需为 MEX 配置模型密钥。

独自开发？下一位使用这些记忆的人，也可以是开启新会话后的你。

<a id="from-one-engineer-to-the-next"></a>

## 从一位工程师交到下一位

举个例子：Alex 修改 webhook 的重试处理，Sam 将接着完成后续工作。团队已为仓库配置好 MEX，两人都是处于启用状态的 MEX Member。

1. **从团队上下文开始。** Alex 让 Codex 在修改代码和运行测试之前，先查看已有架构、相关决策和代码依据。
2. **留下有用的发现。** 在 Alex 的指导下，Codex 更新相关 Wiki 说明和代码引用。如果工作改变了需要长期保留的产品需求，它会另行准备一份 Inbox 提案，等待明确审批。
3. **准备并发布交接。** Alex 请 `$mex-relay` 为 Sam 起草一份 Relay：改了什么、运行了哪些测试、还剩什么、接下来应该看哪里。Alex 在 Hub 中审阅草稿和发布预览，明确发布后，再通过 Git 审阅、提交并推送代码和 MEX 权威记录文件。
4. **利用共享上下文继续。** Sam 拉取相关分支，按需更新本地索引，然后打开 Hub。Sam 审阅并接手 Relay，再让自己的编程智能体读取其中的上下文并继续工作。这次接手确认也会形成需要提交和推送的权威记录变更。

![一位工程师准备并发布 Relay，通过 Git 共享；下一位工程师接手这份持久交接记录。](docs/diagrams/readme/relay.svg)

Relay 携带的是说明和当时观察到的仓库状态，而不是尚未提交的代码。发布只会向 Alex 的检出目录写入文件；在通过 Git 共享之前，它不会通知 Sam，也不会传递任何内容。生命周期与并发细节见 [Relay 的边界](#relay-pass-the-context-baton)。

<a id="project-hub"></a>

## Project Hub

Hub 是供人浏览和审阅团队记忆的地方。你可以用它了解代码库的一部分、查看一项 Spec 变更提案、找到发给自己的交接，或回顾已记录的团队历史。

![在本地 Project Hub 中探索 Wiki 与 Code，审阅 Inbox 与 Specs，并协调 Relays 和团队成员。](docs/diagrams/readme/hub.svg)

- **理解项目：** Overview、Search、Knowledge、Specs 和 Code 将文字说明与实现依据连接起来。
- **审阅并推进工作：** Inbox 支持受审批流程管控的 Spec 提案；Relays 保留下一位接手者所需的信息；Workstreams 保存周边上下文。
- **了解参与者与记录：** Team/Members 支持贡献归属和本地身份选择。Activity 展示已接受的 MEX 工作流事件和已记录的项目笔记，而不是每一次代码编辑或 Git 操作。
- **保持上下文可用：** Health 和 Jobs 展示索引状态，并提供显式维护操作。

完成设置后，运行 `mex hub`。每位工程师的 Hub 读取各自的检出目录，并监听 `127.0.0.1`；它不是共享的托管式仪表盘。Git 将团队的权威记录带入该检出目录。Hub 使用服务端会话和 CSRF 令牌保护修改操作。Playbooks 和 Catch Up 标记为 **Coming Soon（即将推出）**，在 0.8 中尚不可用。

<a id="quick-start"></a>

## 快速开始

MEX 需要 **Node.js 22.5 或更高版本**，以及一个 Git 仓库。标准 npm 流程适用于 macOS、Linux、Windows 命令提示符、PowerShell 和 WSL。

<a id="introduce-mex-to-your-repository"></a>

### 在仓库中引入 MEX

在仓库根目录运行：

```bash
npx mex-agent@0.8.2 setup
```

此命令会在本地浏览器中打开设置向导。选择 AI 工具，构建脚手架和索引，并让可用的 Claude Code 或 Codex CLI 填充项目记忆。若智能体不可用或运行失败，可复制提示词，手动完成后继续。现有指令会保留；需要手动补充的集成指引不会阻止设置。

在 Hub 中审阅确切的设置文件差异，点击 **Commit setup** 创建本地提交，也可以使用手动 Git 检查点。完成页面会说明如何开启新会话并验证项目记忆，还可选择安装当前版本的全局命令，或留下电子邮箱和可选姓名。联系信息通过内嵌 Web3Forms 服务发送，不写入仓库或使用遥测；本机只记录已提交或已跳过。点击 **Open Hub** 后进入完整 Hub 和首次使用导览。

若偏好终端或通过 SSH 操作，请运行 `npx mex-agent@0.8.2 setup --cli`。`setup --dry-run` 仍是只读终端预览；`--no-open` 只打印浏览器链接，`--port <n>` 指定本地端口。安装后，`mex` 打开 Hub 或设置，`mex tui` 打开终端面板。智能体仍需自行安装并满足账户和网络要求。

![准备好项目的三个步骤：运行设置、填充记忆，然后审阅并提交检查点，再打开 Hub。](docs/diagrams/readme/setup.svg)

> [!NOTE]
> 完整 Hub 需要当前 `.mex/config.json` 已提交到 `HEAD`。Hub 只会在你审阅并明确选择提交后创建本地设置提交，并保留无关的暂存内容。MEX 从不推送或拉取。

通过团队常用的 Git 流程推送已审阅的设置提交，让队友获得相同的项目记忆和所选智能体指令。在 Hub 的 Team/Members 页面中添加参与者，并选择你的本地身份。明确审阅和应用这些操作；新的 Member 记录也需要提交和推送。你选择的当前成员身份仅保留在本地。

<a id="join-a-repository-already-using-mex-08"></a>

### 加入已使用 MEX 0.8 的仓库

通过 Git 克隆或拉取团队的仓库和分支。如果 0.8 设置已完成并提交，在自己的检出目录中构建派生索引，然后打开 Hub：

```bash
npx mex-agent@0.8.2 graph rebuild
npx mex-agent@0.8.2 wiki rebuild-index
npx mex-agent@0.8.2 hub
```

复用共享的项目记忆，不要仅为加入项目而重新生成。在 Team/Members 中检查实际生效的身份，并按需选择你已有的 Member 记录作为本地覆盖设置。如果尚无记录，请通过经过审阅的工作流明确创建一条，并共享其权威记录文件。Members 用于标明归属，不是登录或权限系统。

已提交的指令文件和技能目录可以由其目标智能体复用。单独安装智能体，并在仓库中开启新会话。如果共享设置未包含你选择的集成，请与团队协调添加；详见[智能体集成](#agent-workflows)。后续拉取或切换分支后，请检查 Graph/Wiki 健康状态，并执行提示的显式维护操作——读取不会悄悄更新索引。

较旧或尚未完成的设置应先遵循[升级与兼容性](#upgrade-and-compatibility)说明。在交换新 Relays 之前，保持 CLI 版本一致。

<details>
<summary><strong>更喜欢全局安装？</strong></summary>

```bash
npm install -g mex-agent@0.8.2
mex setup
```

npm 包名为 `mex-agent`，安装后的命令为 `mex`。运行 `mex hub` 前，请先完成上面的审阅和提交检查点。

浏览器和终端设置中的可选全局安装都会固定到当前运行的 MEX 版本。安装失败不会影响已完成的设置；可以重试或手动运行上面的命令。

</details>

<a id="agent-memory-mode"></a>
<details>
<summary><strong>想将 MEX 用于长期运行的运维智能体？</strong></summary>

```bash
npx mex-agent@0.8.2 setup --mode agent-memory
```

这个独立模板将 MEX 的路由与维护模型应用于家庭实验室、基础设施，以及长期运行的智能体工作空间。它增加了 `HEARTBEAT.md` 约定和清理规范；本 README 描述的 Code Graph、Wiki 和团队 Hub 流程属于默认的 `code-repo` 模式。

</details>

为便于阅读，示例使用 `mex`。你可以按上述方式全局安装，或将其替换为 `npx mex-agent@0.8.2`。

<a id="how-mex-works"></a>

## MEX 的工作原理

团队记忆是共享的，检索它的机制则留在本地。MEX 将**仓库中的权威文件**与**可重建的索引**分开，让每位工程师及其智能体都能基于各自的检出目录工作。

![仓库源码和 Markdown 输入本地 MEX 引擎。智能体通过 CLI 访问，人通过 Project Hub 使用。](docs/diagrams/readme/architecture.svg)

<a id="canonical-markdown-local-indexes"></a>

### Markdown 是权威记录，索引留在本地

权威知识记录是带有元数据、关系、来源、溯源信息和代码关联的结构化 Markdown；被接受的 Wiki 写入会追加审计记录。Code Graph 和 Wiki 搜索索引是可重建的本地 SQLite 视图，而不是共享的权威数据源。

| 提交并推送以共享 | 保留为本地或临时状态；不要提交 |
| --- | --- |
| `.mex/config.json`、`.mex/.gitignore` | `.mex/graph.db*` |
| `.mex/AGENTS.md`、`.mex/ROUTER.md`、`.mex/SETUP.md`、`.mex/SYNC.md` | `.mex/wiki.db*` |
| `.mex/context/**`、`.mex/patterns/**`、`.mex/specs/**`、`.mex/topics/**` | `.mex/local/**`：草稿、当前成员选择、作业、游标、恢复状态、签名密钥 |
| `.mex/team/members/**`、`.mex/workstreams/**`、`.mex/inbox/**`、`.mex/relays/**` | 进程内存中的 Hub 会话注册表，以及浏览器持有的会话/CSRF 状态 |
| `.mex/events/activity/**`、`.mex/events/operations.jsonl`、`.mex/events/decisions.jsonl` | — |
| 设置时选定的智能体指令文件，以及 `.agents/skills/mex-*` 或 `.claude/skills/mex-*` | — |

Git 传递的是知识内容；设置流程或显式维护命令会针对各检出目录自身的分支和工作树重建索引。代码仍是判断实现行为的依据，代码关联漂移则会标记需要审阅的相关说明。

<a id="wiki-code-graph-and-grounding"></a>

## Wiki、Code Graph 与代码关联

共享记忆既需要团队的解释，也需要实现层面的证据。MEX 将仓库的两种互补视图结合起来：

- **Wiki** 以便于人审阅的语言解释架构、约定、决策、模式、主题和 Specs。
- **Code Graph** 使用内置的 Tree-sitter 语法，将实现中的符号与关系映射到本地 SQLite 索引，以支持精确、范围受限的检索。

检查或显式维护它们：

```bash
mex graph status
mex graph refresh       # Republish an existing compatible store
mex graph rebuild       # Full replacement when status requires it
mex wiki rebuild-index
mex wiki query "authentication"
```

向 Graph 查询与任务范围相称的证据集，或精确的结构关系：

```bash
mex graph scope "trace the authentication flow"
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph get <node-id>
mex impact requireSession
```

MEX 支持索引 TypeScript/TSX、JavaScript/JSX、Python 和 Rust。`.mts`、`.cts`、`.mjs`、`.cjs` 等模块变体仅有部分支持，Express 是 0.8 文档中唯一列明具有框架专用解析器的框架。精确的 `query`、`get`、`impact` 读取以及 Hub Code 都要求 Graph 能被证明确实为最新状态；对于索引过期或尚未索引的文件，`scope` 则可以返回范围受限的实时文本证据，并明确标记为 `text-only`。

<a id="grounding-and-drift"></a>

### 代码关联与漂移

Wiki 中的一项说明可以指向确定性的图节点。MEX 会保存节点 ID 和身份指纹；MEX 新写入的代码关联还包含代码主体哈希，而兼容的旧版关联可能退回到较粗粒度的指纹比较。这些信号共同用于区分完好、已变更、已移动、缺失、有歧义和尚未验证的引用。

![Wiki 中的说明关联到代码符号。代码发生变化时，可以将该说明标记为待审阅。](docs/diagrams/readme/grounding.svg)

漂移是一种提示审阅的信号。它**不能**证明文字说明是错的、代码变更有问题，或模型确实基于检索到的上下文进行了推理。

<a id="agent-workflows"></a>
<a id="agents-help-maintain-the-teams-memory"></a>

## 智能体协助维护团队记忆

智能体既是读者，也是贡献者：它们可以检索团队已有的上下文、协助记录实际工作中的发现，并准备交由人审阅的 Spec 提案或交接。它们不会自行决定哪些内容应当发布或共享。

设置流程会安装简短的宿主智能体指令，指向 `.mex/AGENTS.md` 中的策略和 `.mex/ROUTER.md` 中与任务相关的上下文。只要宿主遵循这些指令，智能体就可以查询 Wiki 与 Graph 证据。

![智能体遵循项目指令和 Router，检索与任务相关的上下文及代码依据。](docs/diagrams/readme/context-routing.svg)

| 集成 | 设置行为 | 显式技能命令 |
| --- | --- | --- |
| **Claude Code** | 安装或更新项目入口指令，以及 `.claude/skills/` 下的技能 | `/mex-inbox`、`/mex-relay` |
| **Codex** | 安装或更新项目入口指令，以及 `.agents/skills/` 下的技能 | `$mex-inbox`、`$mex-relay` |
| **Cursor、Windsurf、GitHub Copilot、OpenCode** | 安装相应的指令入口/模板 | 0.8 中没有官方 MEX 技能命令 |

如果现有设置缺少你所需的 Claude Code 或 Codex 文件，请显式预览并同步该集成：

```bash
mex skills sync --dry-run --tool codex
mex skills sync --tool codex
```

Claude Code 使用 `--tool claude`。审阅生成的指令和技能文件；如果团队需要共享该集成，请提交并推送这些文件，然后开启新的智能体会话。

指令可以根据明确的自然语言意图选择 Inbox 或 Relay，但技能激活绝不等于批准对权威记录的写入。当 MEX 上下文对工作产生实质影响时，智能体会指出使用了哪些记录；这用于提高透明度，而不是证明其推理过程。

受审批流程管控的 Inbox 路径适用于 Spec 及其相关类型的提案。普通 Wiki 和上下文更新不必全部通过 Inbox；请通过正常的工程流程审阅这些工作树变更。

<a id="mcp-server"></a>
<details>
<summary><strong>MCP 服务器——仅提供源码</strong></summary>

仓库包含用于本地开发的 [MCP 工作区](https://github.com/mex-memory/mex/tree/v0.8.0/packages/mex-mcp)。它未随 MEX 0.8 发布；已发布的智能体接口是 `mex-agent` CLI 及其项目指令和技能。

</details>

<a id="human-approval-boundaries"></a>

### 人工审批边界

| 智能体可以准备 | 由人明确控制 |
| --- | --- |
| 搜索和检索 Wiki 或 Graph 证据 | 判断检索到的证据是否充分 |
| 创建仅属于当前检出目录的 Inbox 草稿 | 发布提案以供仓库审阅 |
| 预览范围受限的 Spec 创建/更新操作 | 批准或拒绝拟议的权威记录变更 |
| 创建仅属于当前检出目录的 Relay 草稿 | 发布、接手和关闭交接 |
| 建议更新上下文和代码关联 | 审阅并提交工作树变更 |

团队工作流使用签名预览绑定已审阅的输入，并检测过期或被篡改的计划；Wiki 写入使用计划与 `--apply` 之间的边界。这些机制保护的是修改操作的完整性，不是身份认证、操作系统隔离、仓库权限，也不能证明命令确实由人发出。

<a id="team-workflows"></a>

## 团队工作流

这些工作流帮助团队决定哪些内容应成为持久知识，并保留足够的上下文供他人继续工作。它们与你已有的代码审查和问题跟踪工具配合使用。

| 功能 | 用途 | 共享边界 |
| --- | --- | --- |
| **Members** | 稳定的贡献者记录，以及用于标明归属、仅属于当前检出目录的“当前成员”设置 | Member 记录通过 Git 共享；当前选择留在本地 |
| **Workstreams** | 持久保留某个工作领域及其状态的上下文 | 权威 Markdown 文件通过 Git 共享 |
| **Specs** | 结构化产品需求、约束和验收标准 | 权威 Markdown 文件通过 Git 共享 |
| **Inbox** | 针对一项范围受限的 Spec 类创建或更新操作、受审批流程管控的提案 | 草稿留在本地；已发布提案与决定通过 Git 共享 |
| **Relays** | 由智能体准备、由人发布的上下文交接 | 草稿留在本地；发布、接手或关闭后的记录通过 Git 共享 |
| **Activity** | 已接受的 MEX 工作流历史和自定义记录 | 权威记录通过 Git 共享 |

Members 提供归属和溯源信息。它们**不是**账户、身份认证、基于角色的访问控制或仓库权限。

<a id="inbox-propose-before-changing-durable-specs"></a>

### Inbox：先提案，再变更持久 Specs

Inbox 技能为 Spec、需求、约束或验收标准准备恰好一项范围受限的 `spec.create` 或 `spec.update` 提案。本地草稿在成为仓库记录之前可以先预览；批准后，经过审阅的操作才会应用到权威知识记录。

![Inbox 草稿在发布前留在本地。人工审阅和明确批准后，提案才会转为权威 Spec 记录。](docs/diagrams/readme/inbox.svg)

提案在权威记录中的每次状态转换，仍然需要通过普通提交、推送和拉取才能到达另一份检出目录。批准、拒绝和撤回都是终态；过期提案可以修复并恢复为待处理状态。作者可以使用特殊的自我批准流程，因此 Inbox 旨在确保明确审批，而不保证一定由同事审阅。

0.8 中的 Inbox 有意聚焦于 Spec 及其相关类型。它不是通用 Wiki 编辑器，也不是任意笔记的收集队列。

<a id="relay-pass-the-context-baton"></a>

### Relay：传递上下文接力棒

Relay 打包下一位接手者需要的信息：发布时解析出的已启用发送者、1 至 32 位拥有权威 Member 记录且互不重复、处于启用状态的接收者、一段摘要、可选的关联上下文（例如 Workstream），以及当时观察到的仓库状态。该快照包括可获取的分支和 `HEAD`、表示工作树是否存在未提交变更的布尔值，以及时间戳。发布时会拒绝已停用、重复或无法解析的接收者；不会存储 diff 或未提交变更的文件内容。

Relay 是持久交接记录，不是聊天、实时通知、任务分配，也不是 Jira 的替代品。

在同一个已观察到的仓库状态内，第一位成功接手的合格接收者会成为唯一的接手人。不同克隆之间不存在网络锁，因此两位尚未同步的接收者可能分别接手，随后在 Git 中遇到冲突。只有记录中的发送者或接手人在仍处于启用状态时才能关闭 Relay；停用其中任何一方都可能阻碍关闭。0.8 没有拒绝接手、重新指派、取消接手、重新打开或管理员覆盖流程。

<a id="command-map"></a>

## 命令速查

运行 `mex <command> --help` 查看完整接口。

| 目标 | 命令 |
| --- | --- |
| 设置或检查兼容性 | `mex setup`、`mex capabilities`、`mex skills sync` |
| 使用长期运行智能体模式 | `mex setup --mode agent-memory`、`mex heartbeat` |
| 打开本地界面 | `mex hub`、`mex tui` |
| 构建和检索代码上下文 | `mex graph status`、`mex graph refresh`、`mex graph rebuild`、`mex graph scope <task>`、`mex graph query <relation> <target>`、`mex graph get <node-id>`、`mex impact <target>` |
| 索引和检索知识 | `mex wiki rebuild-index`、`mex wiki query <text>`、`mex wiki show <id>`、`mex wiki related <id>`、`mex wiki backlinks <id>`、`mex wiki for-code <node-id>` |
| 综合整理或维护 Wiki | `mex wiki build`、`mex wiki prepare --stage <stage> [--cluster <name>]`、`mex wiki validate`；`mex wiki propose <response-file>` 和 `mex wiki apply <operation-file>` 默认只预览，只有添加 `--apply` 才会写入 |
| 审阅团队记忆 | `mex member --help`、`mex activity --help`、`mex workstream --help`、`mex spec --help` |
| 管控 Spec 提案 | `mex inbox draft --help`、`mex inbox publish --help`、`mex inbox proposal --help` |
| 准备和接收交接 | `mex relay draft --help`、`mex relay publish --help`、`mex relay acknowledge --help`、`mex relay close --help` |
| 记录项目笔记或管理模式 | `mex log <message>`、`mex timeline`、`mex pattern --help` |
| 检查和维护项目 | `mex check`、`mex sync`、`mex doctor`、`mex watch` |

使用 `mex capabilities --json` 获取机器可读的能力信息，使用 `mex commands` 查看简洁的 CLI 命令图谱。

<a id="upgrade-and-compatibility"></a>

## 升级与兼容性

如果使用全局安装，请升级 CLI 并刷新所选 Claude Code/Codex 技能副本：

```bash
npm install -g mex-agent@0.8.2
mex skills sync --dry-run
mex skills sync
```

如果已完成 0.8.0 的设置，上述命令会更新受管理的技能和智能体指引；无需仅为升级软件包而重新运行 setup。请检查与本地修改的指引之间报告的冲突，然后开启新的智能体会话。

仅升级软件包和技能，并不能让旧仓库或尚未完成设置的仓库立即满足 Hub 的运行条件。对于这些仓库，请先通过 dry run 检查 setup 的变更，再实际应用；setup 会保留现有编写的文件，其变更仍需审阅：

```bash
mex setup --dry-run
mex setup
git status --short
mex capabilities --json
```

提交前，请审阅每一项生成的变更。尤其要确认 `.mex/graph.db*`、`.mex/wiki.db*` 和 `.mex/local/` 已被忽略。

已有的 Markdown 基础结构仍然有效，Graph 读取从不隐式迁移数据存储。兼容的 schema-v2 和完整的 schema-v3 存储可以通过显式修复升级；schema-v1、不完整、有歧义、格式错误或已损坏的存储则需要重建。请遵循 `mex graph status` 给出的具体操作。不要添加忽略整个 `.mex/` 的规则——这会隐藏团队本应共享的权威记忆文件。

> [!WARNING]
> **共享新的面向团队开放的 Relay 之前，请先让全团队升级到 0.8.1**，因为这类 Relay 使用 schema-v4。已有的 schema-v1 至 schema-v3 Relay 仍受支持，指定接收人的交接仍使用 schema-v3。MEX 要求 Node 22.5 或更高版本，且[内置 SQLite 必须支持 FTS5](COMPATIBILITY.md#sqlite-fts5)。Node 20 用户应继续使用 MEX 0.6.3，直到能够换用受支持的 Node 构建版本。

<a id="privacy-and-trust-model"></a>

## 隐私与信任模型

MEX 不会将其权威记录、Graph、Wiki 索引、草稿、身份选择或 Hub 会话上传到 MEX 服务。它不提供自动的团队数据传输：共享依靠你执行的常规 Git 操作。Hub 绑定到回环地址，MEX 的本地检索层无需模型凭证。

MEX 具有**使用假名标识的 CLI 和 Hub 使用遥测**，默认启用，除非你选择退出。遥测记录命令名称和结果、Hub 的明确操作、页面类别及后台任务结果。两者共用一个随机安装 UUID，以衡量重复使用情况。如果配置可用，事件还会包含已有的 scaffold UUID，用于估算项目的共享使用情况，以及项目配置中选定的 AI 工具名称；这些信息不能识别当前调用命令的智能体，也不能确定团队人数。能访问项目配置的人可以将该 scaffold UUID 与项目关联。不会发送名称、仓库远程地址、参数值、路径、内容、搜索文本或联系方式。接收服务可以观察到常规传输元数据。事件使用有大小限制的本地队列；CLI 退出时只短暂等待，离线发送不会改变命令结果。

通过以下命令检查或关闭遥测：

```bash
mex telemetry inspect
mex telemetry status
mex telemetry disable
```

也可以通过 `MEX_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 禁用。控制选项和精确载荷见[遥测政策](TELEMETRY.md)。连接到 MEX 的编程智能体可能有自己的网络和遥测行为；这些由相应工具决定，而非 MEX。

<a id="what-mex-is-not"></a>

## MEX 不是什么

MEX 0.8 **不**提供：

- 云托管 Hub 或托管式知识同步；
- 实时通知、在线状态或即时聊天；
- 自动 Git 暂存、提交、推送或拉取；
- 身份认证、仓库授权或 RBAC；
- Jira 式任务管理；
- 共享的 Code Graph 或 Wiki SQLite 数据库；
- 自动证明模型正确使用了检索到的上下文；
- 所谓的语义或向量搜索引擎——Wiki 使用全文搜索，Graph 使用词法/结构检索；
- 通过 Hub 进行通用 Wiki 编辑；
- 已发布的 MCP 服务器或 MCP 软件包——源码工作区不是 0.8 的公开产品功能；
- 仅存在于未来计划或设计文档中的功能。

MEX 将团队记忆保存在仓库文件中，并提供本地检索和审阅工作流。分发、访问控制和代码审查由 Git 及现有工程工具负责。

<a id="explore-further"></a>

## 继续了解

- 阅读 [MEX 0.8 发行说明](https://github.com/mex-memory/mex/releases/tag/v0.8.0)。
- 查看[运行时与兼容性指南](https://github.com/mex-memory/mex/blob/v0.8.0/COMPATIBILITY.md)和[安全政策](https://github.com/mex-memory/mex/blob/v0.8.0/SECURITY.md)。
- 查阅 [Code Graph 支持矩阵](https://github.com/mex-memory/mex/blob/v0.8.0/docs/code-graph-support.md)。
- 了解[提取器模型和支持的关系](https://github.com/mex-memory/mex/blob/v0.8.0/docs/extractors.md)。
- 阅读 [Code Graph 检索基准结果](https://github.com/mex-memory/mex/blob/v0.8.0/evaluate/RESULTS.md)，其中包含与普通文件搜索基线的盲评对比。
- 在本地使用 `mex capabilities --json` 和 `mex commands` 检查 CLI。
- 加入 [Discord 上的 MEX 社区](https://discord.gg/FEdNsQ4Qt4)，或访问 [mexmemory.com](https://mexmemory.com)。
