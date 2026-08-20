<div align="center">

<img src="mascot/mex-mascot.svg" alt="Mascota de mex" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="Logotipo ASCII de MEX" width="520">

**Una wiki viva para tu código, mantenida por tus agentes de programación con IA.**

[English](README.md) | [简体中文](README.zh-CN.md) | **Español** | [Português (Brasil)](README.pt-BR.md)

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/badge/stars-1.2K%2B-111111)](https://github.com/mex-memory/mex/stargazers)
[![Website](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/VG7ySSMQM)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/node-%3E%3D22.5-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#modo-de-memoria-del-agente)
[![MCP](https://img.shields.io/badge/MCP-compatible-6f8cff)](#servidor-mcp)

</div>

---

mex crea un mapa de tu código, convierte lo que aprenden los agentes en Markdown estructurado y mantiene ese conocimiento conectado con la implementación que describe.

Cada sesión de programación comienza con el contexto arquitectónico relevante, no con otro escaneo completo del repositorio.

> **Nuevo en v0.7.2:** recuperación del grafo con código fuente en una sola llamada, flujos de TypeScript resueltos por el compilador, evidencia determinista y límites estrictos de salida.

💬 **Únete a la comunidad de mex en Discord** — comenta ideas, obtén ayuda, comparte tus opiniones y contribuye al proyecto.

[Unirse a Discord →](https://discord.gg/VG7ySSMQM)

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="Panel operativo de memoria de proyectos de mex" width="640">
</p>

## Tu código sabe más que su documentación

La arquitectura, las convenciones, los casos límite y las decisiones históricas están dispersos entre el código fuente, los pull requests, los chats y las personas que contribuyen al proyecto.

Los agentes de programación con IA redescubren ese conocimiento en cada sesión. Un enorme archivo de instrucciones puede ayudar al principio, pero termina saturando la ventana de contexto, quedándose obsoleto y alejándose de la implementación real.

mex crea una wiki viva dentro del repositorio que crece mientras trabajan los agentes:

- los agentes documentan lo aprendido en Markdown legible
- un grafo de código determinista conecta ese conocimiento con símbolos exactos
- el enrutamiento por tarea carga solo el contexto necesario
- las comprobaciones de desviación detectan conocimiento afectado por cambios en el código
- el trabajo completado incorpora decisiones, patrones y el estado actual del proyecto a la wiki

El código sigue siendo la fuente de verdad. La wiki se convierte en su explicación mantenida.

| Documentación de proyecto convencional | Wiki viva de mex |
|---|---|
| Se escribe una vez y se olvida gradualmente | Crece a partir del trabajo real |
| Está desconectada de la implementación | Sus afirmaciones apuntan a símbolos exactos |
| Se carga como un enorme archivo de instrucciones | El contexto se enruta según la tarea |
| Las refactorizaciones invalidan documentos en silencio | Detecta símbolos modificados, movidos o eliminados |
| Cada agente redescubre la arquitectura | Los agentes heredan descubrimientos y decisiones |
| El conocimiento desaparece entre sesiones | Las decisiones y los patrones permanecen en el repositorio |

## Cómo funciona

### 1. Crea un mapa del código

mex construye un grafo de código local y determinista con Tree-sitter y SQLite. Indexa símbolos y relaciones en TypeScript, TSX, JavaScript, JSX, Python y Rust, incluidas relaciones de rutas a manejadores de Express.

```bash
mex graph
```

### 2. Construye la wiki

Durante la configuración, tu agente usa el grafo para comprender el proyecto y completar una wiki Markdown estructurada:

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

Siguen siendo archivos Markdown normales: legibles, revisables, versionados y editables por personas o agentes.

### 3. Enruta el contexto adecuado

Los agentes comienzan con un pequeño archivo de anclaje en lugar de cargar toda la wiki. Este apunta a `ROUTER.md`, que selecciona la arquitectura, decisiones, convenciones y patrones relevantes para la tarea.

```text
Tarea del agente
    ↓
Pequeño anclaje siempre cargado
    ↓
ROUTER.md
    ↓
Páginas relevantes de la wiki
    ↓
Vecindario compacto del grafo
    ↓
Expansión específica del código fuente
```

![Flujo de enrutamiento de contexto de mex](docs/diagrams/context-routing.svg)

Fuente editable: [docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

### 4. Mantenla actualizada

Después de un trabajo significativo, el agente actualiza el estado del proyecto, registra decisiones y captura patrones reutilizables. mex comprueba que la wiki siga coincidiendo con el repositorio:

```bash
mex check
mex sync
```

`mex check` valida rutas, comandos, dependencias, enlaces, índices, antigüedad, configuración de herramientas y símbolos vinculados sin gastar tokens de IA. Cuando hay que reparar algo, `mex sync` entrega contexto dirigido al agente en vez de pedirle que redescubra todo el proyecto.

![Ciclo de detección y sincronización de mex](docs/diagrams/drift-sync.svg)

Fuente editable: [docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## Vinculada al código

Las páginas de la wiki pueden conectar afirmaciones importantes con nodos exactos del grafo:

```yaml
---
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
---
```

Las referencias importantes también pueden ser navegables dentro del texto:

```markdown
La autenticación la aplica
[`requireSession()`](mex://function:a3f8...c21).
```

Cuando esa función cambia, se mueve o desaparece, mex identifica el conocimiento afectado. Los cambios de nombre y movimientos seguros se vuelven a vincular durante la sincronización; los casos ambiguos se presentan al agente.

Así, el agente puede leer ampliamente para comprender un comportamiento y vincular solo los pocos símbolos que realmente respaldan lo que escribe.

## Recuperación compacta para agentes

El grafo también funciona como capa de recuperación compacta:

```bash
mex graph scope "seguir el flujo de autenticación"
```

En lugar de devolver todo el repositorio, mex prioriza las declaraciones y los flujos de ejecución reales con mayor probabilidad de responder a la tarea, bajo un límite estricto de tokens estimados. La respuesta predeterminada incluye código fuente mediante registros JSONL deterministas `meta`, `source`, `flow` y `summary`.

El código fuente devuelto ya se considera leído. Si el resumen indica `ok`, el agente puede responder directamente aunque se haya truncado contexto opcional de menor prioridad. La expansión exacta sigue disponible cuando falta una declaración o el resumen recomienda continuar:

```bash
mex graph get <node-id>
```

También hay consultas estructurales y análisis de impacto:

```bash
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph query what-calls createServer
mex impact requireSession
```

Los comandos para agentes usan envolturas JSONL deterministas para separar metadatos, resultados y resúmenes de forma fiable.

## Resultados

Un piloto de 24 sesiones comparó el candidato 0.7.2 con búsquedas solo de archivos en 12 tareas de Hono y MEX:

| Medición | Resultado |
|---|---:|
| Respuestas correctas en revisión ciega | **7/12 candidato frente a 6/12 archivos** |
| Cambio en tokens nuevos | **-54,5 %** |
| Cambio en tokens procesados | **-72,5 %** |
| Cambio en coste estimado | **-56,6 %** |
| Cambio en latencia media | **-22,9 %** |
| Fragmentos de código requeridos devueltos | **22/23 (95,7 %)** |
| Flujos requeridos de Hono devueltos | **6/6 (100 %)** |

Cada tarea se ejecutó una vez por variante con Claude Sonnet. Son resultados descriptivos de una muestra pequeña frente a una línea base que solo busca archivos; no comparan con `main` publicado ni prueban un ahorro universal de tokens. Consulta el [informe del benchmark](evaluate/RESULTS.md) para ver la metodología y las limitaciones.

Consulta los [resultados del benchmark](evaluate/RESULTS.md) y el [sistema de evaluación](evaluate/README.md) para ver la metodología, los datos, las limitaciones y los comandos de reproducción.

## Inicio rápido

mex requiere Node.js 22.5 o posterior. El paquete npm se llama `mex-agent` porque `mex` ya estaba ocupado; el comando de la CLI sigue siendo `mex`.

```bash
npx mex-agent setup
```

La configuración inspecciona el repositorio, construye el grafo local, crea la wiki Markdown, pide al agente que la complete usando evidencia del grafo, instala el anclaje correcto y valida el resultado.

Después:

```bash
mex check                    # Comprueba la wiki y sus vínculos con el código
mex sync                     # Repara desviaciones con instrucciones dirigidas
mex graph scope "<task>"     # Recupera contexto compacto para una tarea
```

Si no está instalado globalmente, usa `npx mex-agent` en lugar de `mex`. Puedes instalarlo globalmente con:

```bash
npm install -g mex-agent
```

### Windows

El flujo recomendado `npx mex-agent setup` funciona en Símbolo del sistema, PowerShell o WSL y no necesita bash.

Con el flujo antiguo `setup.sh`, ejecuta instalación, compilación y CLI en el mismo entorno. No compiles en WSL para después ejecutar la CLI desde una terminal nativa de Windows. Consulta el [issue #10](https://github.com/mex-memory/mex/issues/10).

## Comandos principales

| Comando | Función |
|---|---|
| `mex` / `mex tui` | Abre el panel interactivo de terminal |
| `mex setup` | Crea y completa la wiki viva |
| `mex check` | Comprueba la wiki y calcula su puntuación de desviación |
| `mex sync` | Repara conocimiento obsoleto o incoherente |
| `mex graph` | Construye o actualiza el grafo local |
| `mex graph scope <task>` | Recupera contexto compacto para una tarea |
| `mex graph get <node-id...>` | Expande símbolos exactos |
| `mex graph query <relation> <symbol>` | Consulta relaciones estructurales |
| `mex graph ground` | Conecta una wiki anterior a 0.7 con el grafo |
| `mex impact <symbol\|file>` | Encuentra código y wiki afectados por un cambio |
| `mex log <message>` | Registra una decisión, nota, riesgo o tarea |
| `mex timeline` | Muestra eventos recientes |
| `mex heartbeat` | Ejecuta comprobaciones para agentes persistentes |
| `mex completion <shell>` | Imprime autocompletado de shell |
| `mex commands` | Enumera todos los comandos y scripts |

## Proyectos mex existentes

Los proyectos anteriores a mex 0.7 pueden añadir vínculos con el grafo sin regenerar ni reescribir su documentación:

```bash
mex graph
mex graph ground
```

El agente de migración conserva el texto y añade entradas `grounds_to` precisas y referencias `mex://` navegables. Es seguro volver a ejecutarlo.

Sin un grafo, los comprobadores de archivos y texto siguen funcionando. Si SQLite o una gramática no se carga, las comprobaciones del grafo se omiten con una advertencia y el resto de la CLI continúa disponible.

Consulta [Compatibilidad del grafo](docs/code-graph-support.md) para conocer la matriz de lenguajes y relaciones, la degradación gradual y las limitaciones actuales.

## Herramientas compatibles

| Herramienta | Anclaje del proyecto |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |

Los usuarios de Neovim pueden seguir la [guía de integración](docs/vim-neovim.md).

## Servidor MCP

`packages/mex-mcp` expone la wiki y el registro de eventos mediante herramientas Model Context Protocol y reutiliza la misma implementación que la CLI.

El paquete MCP todavía no está publicado. Para desarrollo local:

```bash
npm run build --workspace mex-mcp
```

La publicación principal de v0.7.2 sigue siendo la CLI `mex-agent`.

## Modo de memoria del agente

La experiencia principal de mex es la wiki viva del código. El mismo modelo también sirve para agentes persistentes cuyo “proyecto” es un entorno operativo:

```bash
mex setup --mode agent-memory
```

Este modo añade un contrato `HEARTBEAT.md` y convenciones de limpieza para homelabs, infraestructura y agentes operativos de larga duración.

En una prueba comunitaria independiente con OpenClaw, mex superó 10/10 escenarios estructurados y redujo el contexto cargado aproximadamente un 60 % de media. Estos resultados corresponden al modo de memoria y son independientes del benchmark del grafo.

## Principios

- **Markdown es la interfaz duradera.** Personas y agentes pueden leerlo y editarlo.
- **El código es la fuente de verdad.** Las afirmaciones importantes permanecen conectadas a la implementación.
- **El contexto debe enrutarse, no volcarse.** Los agentes cargan lo necesario.
- **El conocimiento debe crecer del trabajo real.**
- **El mantenimiento debe ser continuo.**
- **La recuperación debe ser determinista.**

## Telemetría

mex recopila datos anónimos y opcionales —nombre del comando, versión y sistema operativo—, nunca rutas, argumentos, contenido, direcciones IP ni datos personales. Inspecciona la carga con `mex telemetry inspect` y desactívala con `DO_NOT_TRACK=1`, `MEX_TELEMETRY=0` o `mex config set telemetry off`. Más información en [TELEMETRY.md](TELEMETRY.md).

## Ecosistema

mex es independiente del proveedor. Las integraciones, ejemplos patrocinados y recetas de la comunidad deben ser útiles por sí mismos, estar claramente identificados y vivir en la documentación.

## Contribuir

Las contribuciones son bienvenidas. Consulta [CONTRIBUTING.md](CONTRIBUTING.md).

## Registro de cambios

Consulta [CHANGELOG.md](CHANGELOG.md).

## Licencia

[MIT](LICENSE)
