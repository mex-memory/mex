<!-- Translated from README.md at commit: 735e38a -->

<div align="center">

<img src="mascot/mex-mascot.svg" alt="Mascota de Mex" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="Logotipo ASCII de MEX" width="520">

<h1 align="center">Mex: capa de memoria de proyectos para agentes de programación con IA</h1>

**Memoria persistente de proyectos para agentes de programación con IA.**

[English](README.md) | [简体中文](README.zh-CN.md) | **Español** | [Português (Brasil)](README.pt-BR.md)

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
[![MCP](https://img.shields.io/badge/MCP-compatible-6f8cff)](#servidor-mcp)

</div>

---

Los agentes de programación con IA olvidan todo entre sesiones. Mex les proporciona una memoria de proyecto permanente y navegable para que cada sesión comience con el contexto adecuado, en lugar de un bloque de instrucciones sin orientación. Ayuda a comprender el código, conservar decisiones y mantener el contexto del proyecto alineado con el repositorio mediante herramientas para desarrolladores.

> **Estado de la versión:** npm y `main` permanecen en la versión estable v0.6.3. El grafo de código basado en AST/Tree-sitter es una vista previa para desarrolladores de la versión v0.7.0 aún no publicada, disponible en `code-graph-preview`; todavía no se ha publicado en npm.

💬 **Únete a la comunidad de Mex en Discord** — comenta ideas, obtén ayuda, comparte tus opiniones y contribuye al proyecto.

[Unirse a Discord →](https://discord.gg/VG7ySSMQM)

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="Panel operativo de memoria de proyectos de Mex" width="640">
</p>

## ¿Por qué Mex?

La mayoría de las soluciones de memoria para agentes terminan convertidas en un enorme archivo de instrucciones. Eso funciona durante un tiempo, pero después satura la ventana de contexto, consume tokens y se aleja del código real.

| Sin Mex | Con Mex |
|---------|---------|
| Archivos enormes de `CLAUDE.md` / reglas | Un pequeño archivo de anclaje y contexto dirigido |
| Los agentes olvidan decisiones y convenciones | Las decisiones, patrones y el estado del proyecto persisten |
| La documentación se desvía del código en silencio | `mex check` detecta afirmaciones obsoletas o rotas en el scaffold |
| Cada sesión comienza desde cero | Los agentes cargan solo los archivos relevantes para la tarea |
| El trabajo repetido depende del conocimiento informal | Los nuevos patrones surgen de tareas reales |

## Qué hace

Mex crea un scaffold estructurado en Markdown para la memoria del agente:

- `AGENTS.md` / `CLAUDE.md` — pequeño archivo de anclaje cargado por la herramienta
- `ROUTER.md` — tabla que dirige cada tarea a su contexto específico
- `context/` — arquitectura, stack, configuración, decisiones y convenciones
- `patterns/` — guías reutilizables con consideraciones y pasos de verificación
- `.mex/events/decisions.jsonl` — notas de solo anexado mediante `mex log`

La CLI mantiene ese scaffold en orden. Comprueba rutas, comandos, dependencias, índices de patrones, antigüedad y cobertura de scripts sin consumir tokens de IA. Cuando aparece una desviación, `mex sync` genera instrucciones específicas para que el agente corrija únicamente las partes obsoletas.

## Inicio rápido

La versión estable de npm es v0.6.3. Instálala con Node.js 20 o posterior:

El paquete de npm se llama `mex-agent` porque `mex` ya estaba ocupado. El comando de la CLI sigue siendo `mex`.

```bash
npx mex-agent setup
```

Para probar o contribuir a la vista previa del grafo de código, usa Node.js 22.5 o posterior y compila `code-graph-preview` desde el código fuente:

```bash
git clone https://github.com/theDakshJaitly/mex.git
cd mex
git switch code-graph-preview
npm install
npm run build
```

La configuración crea el scaffold `.mex/`, pregunta qué herramienta de IA utilizas, preanaliza el repositorio y genera una instrucción específica para completar los archivos de memoria. Tarda unos cinco minutos.

Al terminar, puedes instalar Mex globalmente:

```bash
mex check        # puntuación de desviación
mex sync         # corregir desviaciones
```

Si omites la instalación global, usa npx:

```bash
npx mex-agent check
npx mex-agent sync
```

También puedes instalarlo globalmente más adelante:

```bash
npm install -g mex-agent
```

### Windows

El flujo recomendado, `npx mex-agent setup`, funciona en cualquier terminal (Símbolo del sistema, PowerShell o WSL) y no necesita bash. Por tanto, la mayoría de los usuarios de Windows no tienen que preocuparse por esta sección.

> **Usuarios de Windows (flujo antiguo con `setup.sh`):** ejecuten todos los comandos dentro de WSL o Git Bash. No mezclen entornos.

Si instalaste mediante el script antiguo `setup.sh`, compilar dentro de WSL y ejecutar después la CLI desde una terminal nativa de Windows provoca errores de “module not found”, porque `node_modules` y la resolución de rutas difieren entre ambos sistemas de archivos. Ejecuta la instalación, compilación y comandos de la CLI en un único entorno: todo en WSL / Git Bash, o todo en Windows nativo mediante `npx mex-agent`.

Consulta el [issue #10](https://github.com/theDakshJaitly/mex/issues/10) para conocer el contexto.

## Cómo funciona

![Flujo de enrutamiento de contexto de Mex](docs/diagrams/context-routing.svg)

El agente comienza con un pequeño archivo cargado automáticamente. Este archivo apunta a `ROUTER.md`, y el router carga únicamente el contexto necesario para la tarea actual. Después de un trabajo significativo, el paso GROW actualiza el estado del proyecto, las decisiones y los patrones de tareas para que el scaffold resulte más útil con el tiempo.

Fuente editable: [docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

## Detección de desviaciones

Once verificadores validan el scaffold frente al código real. Cero tokens, cero IA.

| Verificador | Qué detecta |
|-------------|-------------|
| **path** | Rutas de archivos referenciadas que no existen en el disco |
| **edges** | Destinos de aristas en el frontmatter YAML que apuntan a archivos inexistentes |
| **index-sync** | `patterns/INDEX.md` no sincronizado con los archivos de patrones reales |
| **staleness** | Archivos del scaffold sin actualizar durante más de 30 días o 50 commits |
| **command** | Referencias `npm run X` / `make X` a scripts inexistentes |
| **dependency** | Dependencias declaradas que faltan en `package.json` |
| **cross-file** | Una misma dependencia con versiones distintas entre archivos |
| **script-coverage** | Scripts de `package.json` no mencionados en ningún archivo del scaffold |
| **tool-config-sync** | Archivos de configuración de herramientas de IA instaladas (p. ej., `CLAUDE.md`, `.cursorrules`) sin sincronizar entre sí |
| **todo-fixme** | Marcadores `TODO` / `FIXME` sin resolver en el Markdown del scaffold |
| **broken-link** | Enlaces Markdown locales a archivos que no existen en el disco |

La puntuación comienza en 100. Mex resta 10 por error, 3 por advertencia y 1 por información.

![Bucle de detección y sincronización de desviaciones de Mex](docs/diagrams/drift-sync.svg)

Fuente editable: [docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## Comandos

Todos los comandos se ejecutan desde la raíz del proyecto. Si no hiciste una instalación global, sustituye `mex` por `npx mex-agent`.

| Comando | Qué hace |
|---------|----------|
| `mex` | Abre el panel interactivo de terminal |
| `mex tui` | Abre explícitamente el panel interactivo de terminal |
| `mex setup` | Configuración inicial: crea el scaffold `.mex/` y lo completa con IA |
| `mex setup --mode agent-memory` | Crea plantillas para espacios de memoria de agentes persistentes / homelab |
| `mex setup --dry-run` | Previsualiza la configuración sin realizar cambios |
| `mex check` | Ejecuta los verificadores de desviación y muestra un informe con puntuación |
| `mex check --quiet` | Una línea: `mex: drift score 92/100 (1 warning)` |
| `mex check --json` | Informe completo en JSON |
| `mex check --fix` | Comprueba y pasa directamente a la sincronización si encuentra errores |
| `mex sync` | Detecta desviaciones, elige un modo, permite que la IA corrija, verifica y repite |
| `mex sync --dry-run` | Previsualiza instrucciones específicas sin ejecutarlas |
| `mex sync --warnings` | Incluye en la sincronización archivos que solo tienen advertencias |
| `mex init` | Preanaliza el repositorio y crea un resumen estructurado para la IA |
| `mex init --json` | Resumen bruto del analizador en JSON |
| `mex log <message>` | Añade una nota, decisión, riesgo o tarea pendiente |
| `mex timeline` | Muestra las entradas recientes del registro de eventos |
| `mex heartbeat` | Ejecuta una vez las comprobaciones ligeras de salud para agentes persistentes |
| `mex doctor` | Resumen legible del estado del scaffold |
| `mex watch` | Instala un hook post-commit |
| `mex watch --interval` | Ejecuta heartbeat repetidamente en primer plano |
| `mex watch --uninstall` | Elimina el hook |
| `mex completion <shell>` | Imprime el autocompletado para el shell |
| `mex commands` | Enumera comandos y scripts con sus descripciones |

## Herramientas compatibles

`mex setup` pregunta qué herramienta utilizas y crea el archivo de configuración correspondiente.

| Herramienta | Archivo de configuración |
|-------------|--------------------------|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |
| Codex | `AGENTS.md` |

Los usuarios de Neovim pueden consultar [docs/vim-neovim.md](docs/vim-neovim.md) para configurar Claude Code, Avante.nvim, Copilot.vim y plugins genéricos.

## Servidor MCP

`packages/mex-mcp` expone Mex a agentes de IA mediante llamadas nativas del [Model Context Protocol](https://modelcontextprotocol.io): sin invocar un shell y con respuestas JSON estructuradas. Importa `mex-agent` directamente, por lo que las herramientas ejecutan el mismo código que la CLI y nunca se desvían de ella.

| Herramienta | CLI equivalente | Devuelve |
|-------------|-----------------|----------|
| `mex_check` | `mex check --json` | Informe de desviación: puntuación, problemas y archivos comprobados |
| `mex_log` | `mex log` / `mex timeline` | Añade un evento (`decision`/`note`/`risk`/`todo`) o lee los recientes |
| `mex_timeline` | `mex timeline` | Eventos filtrados por tipo/fecha, los más recientes primero |
| `mex_heartbeat` | `mex heartbeat` | Comprobación de salud: archivos obsoletos y limpieza de memoria pendiente |
| `mex_read_file` | — | Contenido de un archivo del scaffold, restringido a `.mex/` |

Cada herramienta acepta un `projectRoot` opcional (el directorio actual de forma predeterminada), por lo que un servidor puede trabajar con cualquier proyecto. Ejecuta primero `mex setup`: las herramientas necesitan un scaffold `.mex/`.

Configura tu cliente (Claude Code / `.mcp.json` de Cursor):

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

Compílalo primero con `npm run build --workspace mex-mcp`. Una vez publicado, se convertirá en `"command": "npx", "args": ["mex-mcp"]`.

Al comenzar una sesión, el agente se orienta con dos llamadas:

```
mex_check()                   # ¿se está desviando el scaffold?
mex_read_file("ROUTER.md")    # carga el router y después solo el contexto necesario
```

## Antes y después

Salida real de las pruebas de Mex en Agrow, una línea de ayuda agrícola por voz basada en IA.

**Scaffold antes de la configuración:**

```markdown
## Current Project State
<!-- What is working. What is not yet built. Known issues.
     Update this section whenever significant work is completed. -->
```

**Scaffold después de la configuración:**

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

**Directorio de patrones después de la configuración:**

```text
patterns/
├── add-api-client.md
├── add-language-support.md
├── debug-pipeline.md
└── add-rag-documents.md
```

## Resultados en el mundo real

Un miembro de la comunidad lo probó de forma independiente en **OpenClaw** con 10 escenarios estructurados de homelab que abarcan Ubuntu 24.04, Kubernetes, Docker, Ansible, Terraform, redes y monitorización. Las 10 pruebas fueron satisfactorias. Puntuación de desviación: 100/100.

| Escenario | Sin Mex | Con Mex | Ahorro |
|-----------|---------|---------|--------|
| «¿Cómo funciona K8s?» | ~3,300 tokens | ~1,450 tokens | 56% |
| «Abrir un puerto UFW» | ~3,300 tokens | ~1,050 tokens | 68% |
| «Explicar Docker» | ~3,300 tokens | ~1,100 tokens | 67% |
| Consulta multicontexto | ~3,300 tokens | ~1,650 tokens | 50% |

**Reducción media de tokens de aproximadamente un 60 % por sesión.**

## Modo de memoria del agente

`mex setup --mode agent-memory` crea un scaffold para agentes persistentes cuyo «proyecto» es un entorno operativo y no un repositorio de código. Añade un contrato `HEARTBEAT.md` y plantillas que presentan Mex como memoria estructurada y dirigida por tareas:

- `ROUTER.md` registra el estado operativo actual y dirige al agente a los archivos de memoria correctos.
- `context/` almacena arquitectura, stack, convenciones, configuración y decisiones.
- `patterns/` almacena procedimientos reutilizables.
- `.mex/events/decisions.jsonl` almacena notas y razonamientos de solo anexado mediante `mex log`.

`mex heartbeat` es intencionadamente más ligero que `mex check`: lee el frontmatter `last_updated` y los metadatos de limpieza de memoria, imprime `HEARTBEAT_OK` cuando todo está correcto y solo informa cuando el agente debe revisar archivos de contexto o memoria obsoletos. Usa `mex watch --interval` para ejecutar heartbeat repetidamente en un espacio de trabajo de agente persistente.

## Configuración

Los ajustes opcionales se encuentran en `.mex/config.json`. Los valores ausentes usan los predeterminados.

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

## Telemetría

Mex recopila datos de uso anónimos y opcionales (nombre del comando, versión y sistema operativo; nunca rutas, argumentos, contenido de archivos, IP ni datos personales) para comprender cómo se utiliza. Inspecciona la carga exacta con `mex telemetry inspect` y desactívala en cualquier momento con `DO_NOT_TRACK=1`, `MEX_TELEMETRY=0` o `mex config set telemetry off`. Consulta todos los detalles en [TELEMETRY.md](TELEMETRY.md).

## Ecosistema

Mex es independiente del proveedor. Las guías de integración, los ejemplos patrocinados y las recetas de la comunidad deben ser útiles por sí mismos, estar claramente identificados y vivir en la documentación en lugar de modificar silenciosamente la experiencia predeterminada.

## Contribuir

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para ver la configuración y las directrices.

## Registro de cambios

Consulta [CHANGELOG.md](CHANGELOG.md) para conocer el historial de versiones.

## Licencia

[MIT](LICENSE)
