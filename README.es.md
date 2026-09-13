<div align="center">

<h1 id="mex">
  <img src="docs/diagrams/readme/banner.svg" alt="MEX" width="1200">
</h1>

**Memoria compartida del proyecto para ingenieros y sus agentes de programación.**

MEX mantiene la arquitectura, las decisiones, los requisitos y los traspasos de trabajo de tu equipo junto al código. Los ingenieros y sus agentes pueden aprovechar el contexto compartido, revisar propuestas de cambios y dar continuidad al trabajo entre sesiones y compañeros, con Git como medio para compartirlo.

[English](README.md) | [简体中文](README.zh-CN.md) | **Español** | [Português (Brasil)](README.pt-BR.md)

[![Versión en npm](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![Descargas de npm](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![Estrellas en GitHub](https://img.shields.io/github/stars/mex-memory/mex?style=flat)](https://github.com/mex-memory/mex/stargazers)
[![Sitio web](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/FEdNsQ4Qt4)
[![Licencia: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mex-memory/mex/blob/v0.8.0/LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![Memoria para agentes](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#agent-memory-mode)
[![MCP: solo código fuente](https://img.shields.io/badge/MCP-source%20only-6f8cff)](#mcp-server)

[Memoria del equipo](#what-your-team-remembers) · [Ejemplo de traspaso entre compañeros](#from-one-engineer-to-the-next) · [Project Hub](#project-hub) · [Inicio rápido](#quick-start) · [Cómo funciona](#how-mex-works) · [Guía de comandos](#command-map)

</div>

> La descripción principal de esta traducción sigue correspondiendo a 0.8.0. Los comandos de instalación y las indicaciones de actualización se han ajustado para 0.8.2; los cambios de producto se documentan en el [README en inglés](README.md) y en las [notas de la versión 0.8.2](RELEASE_NOTES.md).

---

Una persona del equipo sabe por qué existe una restricción. Otra conoce el historial de depuración. Un agente de programación encontró un caso límite importante en una sesión que nadie más leerá. El siguiente compañero tiene que reconstruir todo ese contexto.

**Lo que un ingeniero y su agente aprenden debería convertirse en contexto que el siguiente compañero pueda aprovechar.** MEX le da a ese conocimiento un lugar duradero en el repositorio: Markdown legible, explicaciones vinculadas al código, propuestas de Spec revisadas y traspasos estructurados. Las personas lo exploran y revisan en un Hub local; los agentes lo recuperan y ayudan a mantenerlo mediante las instrucciones del proyecto y la CLI.

> [!IMPORTANT]
> **[MEX 0.8](https://github.com/mex-memory/mex/releases/tag/v0.8.0) amplía la memoria de los agentes para convertirla en memoria del equipo:** un Project Hub local, una Wiki estructurada y flujos de trabajo de equipo, Specs con aprobación explícita, Members, Workstreams, Relays, Activity y habilidades (skills) oficiales para Claude Code/Codex, todo conectado con el sistema existente de Code Graph, vinculación al código y detección de divergencias.

💬 **Únete a la comunidad de MEX en Discord** — conversa sobre ideas, pide ayuda, comparte tus comentarios y muestra lo que estás creando.

[Unirse a Discord →](https://discord.gg/FEdNsQ4Qt4)

<a id="what-your-team-remembers"></a>

## Lo que recuerda tu equipo

| Lo que el equipo necesita conservar | Dónde vive en MEX |
| --- | --- |
| Cómo funciona el sistema y por qué | Arquitectura, decisiones, convenciones y patrones en la Wiki, vinculados al Code Graph |
| Lo que debe hacer el producto | Specs, requisitos, restricciones y criterios de aceptación; propuestas en Inbox para cambios sujetos a aprobación |
| Dónde debe continuar otro ingeniero | Relays con avances, decisiones, bloqueos, evidencia y próximos pasos |
| El contexto de un área de trabajo | Workstreams y su estado registrado |
| Quién participa y qué registró MEX | Members e historial de Activity |

![Un ingeniero y su agente aportan memoria compartida al equipo mediante Git. Un compañero y su agente la reutilizan en una copia de trabajo independiente, con sus propios índices locales.](docs/diagrams/readme/git-sharing.svg)

La memoria canónica viaja mediante las operaciones habituales de Git: commit, push y pull. Cada compañero mantiene sus propios índices locales, borradores, selección de identidad y Hub. No se requiere un servicio alojado de MEX, Docker, un proxy, una cuenta de MEX ni una clave de modelo propia de MEX.

¿Trabajas por tu cuenta? La siguiente persona que use esa memoria puedes ser tú en una nueva sesión.

<a id="from-one-engineer-to-the-next"></a>

## De un ingeniero al siguiente

Un ejemplo: Alex modifica la gestión de reintentos de webhooks y Sam continuará el trabajo. Ambos son Members activos de MEX en un repositorio que su equipo ya ha configurado.

1. **Empieza con el contexto del equipo.** Alex le pide a Codex que consulte la arquitectura existente, las decisiones relevantes y la evidencia del código antes de realizar el cambio y ejecutar las pruebas.
2. **Conserva los descubrimientos útiles.** Siguiendo las indicaciones de Alex, Codex actualiza la explicación correspondiente en la Wiki y las referencias al código. Si el trabajo modifica un requisito duradero del producto, prepara una propuesta independiente en Inbox para su aprobación explícita.
3. **Prepara y publica el traspaso.** Alex le pide a `$mex-relay` que redacte un Relay para Sam: qué cambió, qué pruebas se ejecutaron, qué queda pendiente y dónde buscar a continuación. Ella revisa el borrador y la vista previa de publicación en Hub, lo publica explícitamente y luego revisa el código y los archivos canónicos de MEX, hace commit y los comparte con un push de Git.
4. **Continúa a partir del contexto compartido.** Sam hace pull de la rama correspondiente, actualiza sus índices locales según sea necesario y abre Hub. Revisa y toma el Relay; luego le pide a su agente de programación que lea su contexto y continúe. Su confirmación de recepción es otro cambio canónico que debe guardar con un commit y compartir con un push.

![Un ingeniero prepara y publica un Relay, lo comparte mediante Git y el siguiente ingeniero toma el traspaso duradero.](docs/diagrams/readme/relay.svg)

El Relay contiene la explicación y el estado observado del repositorio, no el código sin commit. Publicarlo escribe archivos en la copia de trabajo de Alex; no notifica a Sam ni le entrega nada hasta que lo compartan mediante Git. Consulta los [límites de Relay](#relay-pass-the-context-baton) para conocer los detalles de su ciclo de vida y concurrencia.

<a id="project-hub"></a>

## Project Hub

Hub es el lugar donde las personas exploran y revisan la memoria de su equipo. Ábrelo para comprender una parte del código, inspeccionar una propuesta de cambio de Spec, encontrar un traspaso dirigido a ti o consultar el historial registrado del equipo.

![Explora Wiki y Code, revisa Inbox y Specs, y coordina Relays y miembros de Team en el Project Hub local.](docs/diagrams/readme/hub.svg)

- **Comprende el proyecto:** Overview, Search, Knowledge, Specs y Code reúnen las explicaciones y la evidencia de la implementación.
- **Revisa y da continuidad al trabajo:** Inbox permite gestionar propuestas de Spec sujetas a aprobación; Relays conserva lo que necesita la siguiente persona; Workstreams mantiene el contexto que rodea el trabajo.
- **Ve quién participa y qué ocurrió:** Team/Members permite atribuir contribuciones y seleccionar la identidad local. Activity muestra los eventos aceptados de los flujos de trabajo de MEX y las notas registradas del proyecto, no cada edición de código ni cada operación de Git.
- **Mantén el contexto utilizable:** Health y Jobs muestran el estado de los índices y permiten realizar mantenimiento explícito.

Después de la configuración, ejecuta `mex hub`. El Hub de cada ingeniero lee su propia copia de trabajo y escucha en `127.0.0.1`; no es un panel compartido alojado en un servidor. Git lleva los registros canónicos del equipo a esa copia de trabajo. Hub protege las modificaciones con una sesión del lado del servidor y un token CSRF. Playbooks y Catch Up aparecen como **Coming Soon** (próximamente), y no están disponibles en 0.8.

<a id="quick-start"></a>

## Inicio rápido

MEX requiere **Node.js 22.5 o posterior** y un repositorio Git. El flujo habitual de npm funciona en macOS, Linux, el símbolo del sistema de Windows, PowerShell y WSL.

<a id="introduce-mex-to-your-repository"></a>

### Incorpora MEX a tu repositorio

Ejecuta lo siguiente desde la raíz del repositorio:

```bash
npx mex-agent@0.8.2 setup
```

El comando abre la configuración en el navegador local. Elige las herramientas de IA, crea el scaffold y los índices y deja que una CLI disponible de Claude Code o Codex complete la memoria. Si el agente no está disponible o falla, copia el prompt y continúa después de completarlo manualmente. Las instrucciones existentes se conservan; las indicaciones de integración manual no bloquean la configuración.

Revisa el diff exacto en el Hub y elige **Commit setup** para crear un commit local; también puedes usar el punto de control manual de Git. La pantalla final explica cómo abrir una sesión nueva y verificar la memoria. Ofrece instalar globalmente la versión que está ejecutándose y, de forma opcional, dejar un correo y un nombre opcional. Web3Forms recibe estos datos en el formulario integrado; no entran en el repositorio ni en la telemetría. El equipo solo guarda si enviaste u omitiste la invitación. Elige **Open Hub** para abrir el Hub completo y su recorrido inicial.

Para usar la terminal o SSH: `npx mex-agent@0.8.2 setup --cli`. `setup --dry-run` sigue siendo una vista previa de terminal sin cambios; `--no-open` imprime el enlace y `--port <n>` elige el puerto local. Tras instalar, `mex` abre Hub o la configuración y `mex tui` abre el panel de terminal. Los agentes tienen sus propios requisitos de instalación, cuenta y red.

![Tres pasos para dejar listo el proyecto: ejecutar la configuración, poblar la memoria y después revisar y guardar el punto de control con un commit antes de abrir Hub.](docs/diagrams/readme/setup.svg)

> [!NOTE]
> El Hub completo requiere que el `.mex/config.json` actual esté incluido en `HEAD`. Solo crea un commit local de configuración tras tu revisión y elección explícita, conservando otros cambios en staging. MEX nunca hace push ni pull.

Comparte el commit de configuración revisado mediante un push siguiendo el flujo habitual de Git de tu equipo, para que los demás reciban la misma memoria del proyecto y las instrucciones de los agentes seleccionados. En la página Team/Members de Hub, añade a las personas que participarán y elige tu identidad local. Revisa y aplica esas acciones explícitamente; guarda también los nuevos registros de Member con un commit y compártelos con un push. Tu selección de miembro actual permanece local.

<a id="join-a-repository-already-using-mex-08"></a>

### Únete a un repositorio que ya usa MEX 0.8

Clona el repositorio y la rama del equipo, o actualízalos con un pull de Git. Si la configuración de 0.8 está completa y guardada en un commit, construye los índices derivados en tu propia copia de trabajo y abre Hub:

```bash
npx mex-agent@0.8.2 graph rebuild
npx mex-agent@0.8.2 wiki rebuild-index
npx mex-agent@0.8.2 hub
```

Reutiliza la memoria compartida del proyecto; no la regeneres solo para incorporarte. En Team/Members, comprueba la identidad efectiva y, si hace falta, selecciona tu registro de Member existente para establecerla localmente. Si aún no tienes un registro, créalo explícitamente mediante el flujo con revisión y comparte sus archivos canónicos. Members sirve para atribuir contribuciones, no es un sistema de inicio de sesión ni de permisos.

Los archivos de instrucciones y los directorios de skills guardados en Git pueden reutilizarse con los agentes a los que están dirigidos. Instala el agente por separado e inicia una nueva sesión en el repositorio. Si la integración que elegiste no se incluyó en la configuración compartida, coordina su incorporación con el equipo; consulta las [integraciones de agentes](#agent-workflows). Después de nuevos pulls o cambios de rama, comprueba el estado de Graph/Wiki y ejecuta el mantenimiento explícito indicado: las lecturas no actualizan los índices de forma silenciosa.

Para configuraciones antiguas o incompletas, sigue primero las instrucciones de [actualización y compatibilidad](#upgrade-and-compatibility). Mantén alineadas las versiones de la CLI antes de intercambiar nuevos Relays.

<details>
<summary><strong>¿Prefieres una instalación global?</strong></summary>

```bash
npm install -g mex-agent@0.8.2
mex setup
```

El paquete de npm se llama `mex-agent`; el comando instalado es `mex`. Completa la revisión y el commit del punto de control anterior antes de ejecutar `mex hub`.

La instalación global opcional, tanto en Hub como en la terminal, fija la versión de MEX que se está ejecutando. Si falla, la configuración sigue completa; puedes reintentar o usar el comando anterior.

</details>

<a id="agent-memory-mode"></a>
<details>
<summary><strong>¿Usas MEX para un agente operativo persistente?</strong></summary>

```bash
npx mex-agent@0.8.2 setup --mode agent-memory
```

Esta plantilla independiente aplica el modelo de enrutamiento y mantenimiento de MEX a laboratorios domésticos, infraestructura y espacios de trabajo de agentes de larga duración. Añade un contrato `HEARTBEAT.md` y convenciones de limpieza; el flujo de Code Graph, Wiki y Hub de equipo descrito en este README corresponde al modo predeterminado `code-repo`.

</details>

Los ejemplos usan `mex` para facilitar la lectura. Instálalo globalmente como se indica arriba o sustitúyelo por `npx mex-agent@0.8.2`.

<a id="how-mex-works"></a>

## Cómo funciona MEX

La memoria del equipo se comparte; el mecanismo que la recupera permanece local. MEX separa los **archivos canónicos del repositorio** de los **índices reconstruibles** para que cada ingeniero y agente puedan trabajar con su propia copia de trabajo.

![El código fuente del repositorio y el Markdown alimentan el motor local de MEX. Los agentes acceden mediante la CLI; las personas usan Project Hub.](docs/diagrams/readme/architecture.svg)

<a id="canonical-markdown-local-indexes"></a>

### Markdown canónico, índices locales

El conocimiento canónico es Markdown estructurado con metadatos, relaciones, fuentes, procedencia y vínculos al código; las escrituras aceptadas en la Wiki añaden registros de auditoría. El Code Graph y el índice de búsqueda de la Wiki son vistas locales en SQLite que se pueden reconstruir, no fuentes de verdad compartidas.

| Guarda con commit y comparte con push | Mantén local o efímero; nunca incluyas en un commit |
| --- | --- |
| `.mex/config.json`, `.mex/.gitignore` | `.mex/graph.db*` |
| `.mex/AGENTS.md`, `.mex/ROUTER.md`, `.mex/SETUP.md`, `.mex/SYNC.md` | `.mex/wiki.db*` |
| `.mex/context/**`, `.mex/patterns/**`, `.mex/specs/**`, `.mex/topics/**` | `.mex/local/**`: borradores, selección de miembro actual, trabajos, cursores, estado de recuperación, clave de firma |
| `.mex/team/members/**`, `.mex/workstreams/**`, `.mex/inbox/**`, `.mex/relays/**` | Registro de sesiones de Hub en la memoria del proceso y estado de sesión/CSRF conservado por el navegador |
| `.mex/events/activity/**`, `.mex/events/operations.jsonl`, `.mex/events/decisions.jsonl` | — |
| Archivos de instrucciones de agentes seleccionados durante la configuración y `.agents/skills/mex-*` o `.claude/skills/mex-*` | — |

Git transporta el significado; la configuración o los comandos de mantenimiento explícito reconstruyen los índices a partir de la rama y el árbol de trabajo de cada copia local. El código sigue siendo la fuente de verdad, y la detección de divergencias en los vínculos al código señala las explicaciones que necesitan revisión.

<a id="wiki-code-graph-and-grounding"></a>

## Wiki, Code Graph y vinculación al código

La memoria compartida necesita tanto las explicaciones del equipo como la evidencia de la implementación. MEX combina dos vistas complementarias de un repositorio:

- La **Wiki** explica la arquitectura, las convenciones, las decisiones, los patrones, los temas y las Specs en un lenguaje que las personas pueden revisar.
- El **Code Graph** utiliza las gramáticas de Tree-sitter incluidas para representar los símbolos y las relaciones de la implementación en un índice SQLite local, y así recuperar información con precisión y dentro de límites definidos.

Inspecciónalos o realiza su mantenimiento de forma explícita:

```bash
mex graph status
mex graph refresh       # Republish an existing compatible store
mex graph rebuild       # Full replacement when status requires it
mex wiki rebuild-index
mex wiki query "authentication"
```

Pídele al Graph un conjunto de evidencia acotado a una tarea o una relación estructural exacta:

```bash
mex graph scope "trace the authentication flow"
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph get <node-id>
mex impact requireSession
```

MEX indexa TypeScript/TSX, JavaScript/JSX, Python y Rust. Las variantes de módulos como `.mts`, `.cts`, `.mjs` y `.cjs` tienen cobertura parcial, y Express es el único framework con un resolvedor específico documentado para 0.8. Las lecturas exactas de `query`, `get` e `impact`, así como Code en Hub, requieren un Graph cuya vigencia se pueda demostrar; en cambio, `scope` puede devolver evidencia acotada extraída del texto actual de archivos desactualizados o sin indexar, identificada claramente como `text-only`.

<a id="grounding-and-drift"></a>

### Vinculación al código y detección de divergencias

Una afirmación de la Wiki puede apuntar a un nodo determinista del grafo: esa vinculación se denomina *grounding*. MEX almacena el ID del nodo y una huella de identidad; los nuevos vínculos escritos por MEX también incluyen un hash del cuerpo, mientras que los vínculos antiguos compatibles pueden recurrir a una comparación de huellas menos precisa. En conjunto, estas señales distinguen las referencias intactas, modificadas, movidas, ausentes, ambiguas y no verificadas.

![Una afirmación de la Wiki está vinculada a un símbolo del código. Los cambios en el código pueden marcar la afirmación para revisión.](docs/diagrams/readme/grounding.svg)

La divergencia es una señal para revisar. **No** demuestra que el texto sea falso, que un cambio de código sea incorrecto ni que un modelo haya razonado realmente a partir del contexto recuperado.

<a id="agent-workflows"></a>
<a id="agents-help-maintain-the-teams-memory"></a>

## Los agentes ayudan a mantener la memoria del equipo

Los agentes leen y contribuyen: pueden recuperar el contexto existente del equipo, ayudar a registrar descubrimientos del trabajo real y preparar propuestas de Spec o traspasos para que una persona los revise. No deciden por su cuenta qué se debe publicar o compartir.

La configuración instala instrucciones breves para el agente anfitrión que apuntan a `.mex/AGENTS.md` para las políticas y a `.mex/ROUTER.md` para el contexto relevante de cada tarea. Los agentes pueden consultar evidencia de la Wiki y del Graph, siempre que el anfitrión siga esas instrucciones.

![Un agente sigue las instrucciones del proyecto y el Router para recuperar contexto y evidencia del código relevantes para la tarea.](docs/diagrams/readme/context-routing.svg)

| Integración | Comportamiento de la configuración | Comandos explícitos de skills |
| --- | --- | --- |
| **Claude Code** | Instala o actualiza las instrucciones de entrada del proyecto y las skills en `.claude/skills/` | `/mex-inbox`, `/mex-relay` |
| **Codex** | Instala o actualiza las instrucciones de entrada del proyecto y las skills en `.agents/skills/` | `$mex-inbox`, `$mex-relay` |
| **Cursor, Windsurf, GitHub Copilot, OpenCode** | Instala las instrucciones de entrada o la plantilla correspondiente | Sin comando oficial de skills de MEX en 0.8 |

Si a una configuración existente le faltan los archivos de integración de Claude Code o Codex, previsualiza y sincroniza esa integración explícitamente:

```bash
mex skills sync --dry-run --tool codex
mex skills sync --tool codex
```

Usa `--tool claude` para Claude Code. Revisa los archivos de instrucciones y skills resultantes, guárdalos con un commit y compártelos con un push si el equipo debe compartir la integración, e inicia una nueva sesión del agente.

Las instrucciones pueden seleccionar Inbox o Relay a partir de una intención clara expresada en lenguaje natural, pero la activación de una skill nunca aprueba una escritura canónica. Cuando el contexto de MEX influye de forma sustancial en el trabajo, el agente identifica los registros utilizados; esto aporta transparencia, no una prueba de razonamiento.

El flujo de Inbox sujeto a aprobación se aplica a propuestas de la familia Spec. Las actualizaciones habituales de la Wiki y del contexto no pasan todas por Inbox; revisa esos cambios del árbol de trabajo mediante tu flujo de ingeniería habitual.

<a id="mcp-server"></a>
<details>
<summary><strong>Servidor MCP — solo código fuente</strong></summary>

El repositorio incluye un [workspace MCP](https://github.com/mex-memory/mex/tree/v0.8.0/packages/mex-mcp) para desarrollo local. No se publica con MEX 0.8; la interfaz publicada para agentes es la CLI `mex-agent`, junto con sus instrucciones de proyecto y skills.

</details>

<a id="human-approval-boundaries"></a>

### Límites de la aprobación humana

| Lo que un agente puede preparar | Lo que una persona controla deliberadamente |
| --- | --- |
| Buscar y recuperar evidencia de la Wiki o del Graph | Si la evidencia recuperada es suficiente |
| Crear un borrador de Inbox local a la copia de trabajo | Publicar la propuesta para su revisión en el repositorio |
| Previsualizar una operación acotada de creación o actualización de Spec | Aprobar o rechazar el cambio canónico propuesto |
| Crear un borrador de Relay local a la copia de trabajo | Publicar, tomar y cerrar un traspaso |
| Sugerir actualizaciones del contexto y de los vínculos al código | Revisar y guardar los cambios del árbol de trabajo con un commit |

Los flujos de equipo utilizan vistas previas firmadas para vincular los datos revisados y detectar planes desactualizados o alterados; la edición de la Wiki separa la planificación de la aplicación mediante `--apply`. Estos mecanismos protegen la integridad de las modificaciones, no proporcionan autenticación, aislamiento del sistema operativo, permisos del repositorio ni pruebas de que una persona haya ejecutado el comando.

<a id="team-workflows"></a>

## Flujos de trabajo de equipo

Estos flujos ayudan al equipo a decidir qué se convierte en conocimiento duradero y a conservar suficiente contexto para que otra persona continúe. Complementan tus herramientas existentes de revisión de código y seguimiento de incidencias.

| Función | Qué es | Cómo se comparte |
| --- | --- | --- |
| **Members** | Registros estables de colaboradores y un «miembro actual» local a cada copia de trabajo para atribuir las contribuciones | Los registros de Member usan Git; la selección actual permanece local |
| **Workstreams** | Contexto duradero sobre un área de trabajo y su estado | Markdown canónico mediante Git |
| **Specs** | Requisitos, restricciones y criterios de aceptación estructurados del producto | Markdown canónico mediante Git |
| **Inbox** | Propuestas sujetas a aprobación para una única creación o actualización acotada de la familia Spec | Borrador local; propuesta publicada y decisiones mediante Git |
| **Relays** | Traspasos de contexto preparados por agentes y publicados por personas | Borrador local; registro publicado, tomado o cerrado mediante Git |
| **Activity** | Historial aceptado de los flujos de trabajo de MEX y registros personalizados | Registros canónicos mediante Git |

Members aporta atribución y procedencia. **No** proporciona cuentas, autenticación, control de acceso basado en roles ni permisos del repositorio.

<a id="inbox-propose-before-changing-durable-specs"></a>

### Inbox: propone antes de cambiar Specs duraderas

La skill de Inbox prepara exactamente una propuesta acotada de `spec.create` o `spec.update` para una Spec, un requisito, una restricción o un criterio de aceptación. Se puede previsualizar un borrador local antes de que se convierta en un registro del repositorio, y la aprobación aplica la operación revisada al conocimiento canónico.

![Un borrador de Inbox permanece local hasta su publicación. La revisión humana y la aprobación explícita convierten la propuesta en una Spec canónica.](docs/diagrams/readme/inbox.svg)

Cada transición canónica de una propuesta sigue necesitando las operaciones habituales de commit/push/pull para llegar a otra copia de trabajo. La aprobación, el rechazo y la retirada son estados finales; una propuesta desactualizada puede repararse para volver al estado pendiente. Un autor puede utilizar el flujo excepcional de autoaprobación, por lo que Inbox está diseñado para exigir aprobación explícita, no para garantizar la revisión por otra persona.

Inbox se centra deliberadamente en la familia Spec en 0.8. No es un editor general de la Wiki ni una cola para notas de cualquier tipo.

<a id="relay-pass-the-context-baton"></a>

### Relay: pasa el relevo del contexto

Un Relay reúne lo que necesita la siguiente persona: el remitente activo resuelto al publicar, entre uno y 32 destinatarios únicos con registros canónicos de Member activos, un resumen, contexto relacionado opcional como un Workstream y el estado observado del repositorio. Esa instantánea incluye la rama y `HEAD` cuando están disponibles, además de un valor booleano que indica si hay cambios sin commit y una marca de tiempo. La publicación rechaza destinatarios inactivos, duplicados o que no se puedan resolver; no almacena un diff ni el contenido de los archivos modificados sin commit.

Un Relay es un traspaso duradero, no un chat, una notificación en directo, una asignación de tareas ni un sustituto de Jira.

Dentro de un mismo estado observado del repositorio, el primer destinatario habilitado que logra tomar el Relay queda registrado como la única persona que lo ha tomado. No existe un bloqueo de red entre clones, por lo que dos destinatarios sin sincronizar pueden tomarlo por separado y encontrarse después con un conflicto de Git. Solo el remitente registrado activo o el destinatario registrado activo que lo tomó pueden cerrar el Relay; desactivar a cualquiera de ellos puede impedir el cierre. La versión 0.8 no incluye flujos para declinar o reasignar un Relay, renunciar a uno ya tomado, reabrirlo ni saltarse estas reglas mediante una intervención administrativa.

<a id="command-map"></a>

## Guía de comandos

Ejecuta `mex <command> --help` para consultar la interfaz completa.

| Objetivo | Comandos |
| --- | --- |
| Configurar o inspeccionar la compatibilidad | `mex setup`, `mex capabilities`, `mex skills sync` |
| Usar el modo de agente persistente | `mex setup --mode agent-memory`, `mex heartbeat` |
| Abrir una interfaz local | `mex hub`, `mex tui` |
| Construir y recuperar contexto del código | `mex graph status`, `mex graph refresh`, `mex graph rebuild`, `mex graph scope <task>`, `mex graph query <relation> <target>`, `mex graph get <node-id>`, `mex impact <target>` |
| Indexar y recuperar conocimiento | `mex wiki rebuild-index`, `mex wiki query <text>`, `mex wiki show <id>`, `mex wiki related <id>`, `mex wiki backlinks <id>`, `mex wiki for-code <node-id>` |
| Sintetizar o mantener la Wiki | `mex wiki build`, `mex wiki prepare --stage <stage> [--cluster <name>]`, `mex wiki validate`; `mex wiki propose <response-file>` y `mex wiki apply <operation-file>` muestran una vista previa por defecto y solo escriben con `--apply` |
| Revisar la memoria del equipo | `mex member --help`, `mex activity --help`, `mex workstream --help`, `mex spec --help` |
| Gestionar propuestas de Spec sujetas a aprobación | `mex inbox draft --help`, `mex inbox publish --help`, `mex inbox proposal --help` |
| Preparar y recibir traspasos | `mex relay draft --help`, `mex relay publish --help`, `mex relay acknowledge --help`, `mex relay close --help` |
| Registrar notas del proyecto o gestionar patrones | `mex log <message>`, `mex timeline`, `mex pattern --help` |
| Comprobar y mantener el proyecto | `mex check`, `mex sync`, `mex doctor`, `mex watch` |

Usa `mex capabilities --json` para descubrir las capacidades en un formato legible por máquinas y `mex commands` para ver una guía breve de la CLI.

<a id="upgrade-and-compatibility"></a>

## Actualización y compatibilidad

Para una instalación global, actualiza la CLI y las copias de las skills seleccionadas de Claude Code/Codex:

```bash
npm install -g mex-agent@0.8.2
mex skills sync --dry-run
mex skills sync
```

Si ya completaste la configuración con 0.8.0, estos comandos actualizan las skills y las instrucciones administradas del agente; no hace falta volver a ejecutar setup solo por actualizar el paquete. Revisa los conflictos que se indiquen con instrucciones editadas localmente y después inicia una nueva sesión del agente.

Actualizar el paquete y las skills no basta para que un repositorio antiguo o incompleto esté listo para Hub. Para esos repositorios, evalúa setup con una ejecución de prueba antes de aplicarlo; setup conserva los archivos existentes y sigue requiriendo la revisión de sus cambios:

```bash
mex setup --dry-run
mex setup
git status --short
mex capabilities --json
```

Revisa cada cambio generado antes de hacer commit. En particular, confirma que `.mex/graph.db*`, `.mex/wiki.db*` y `.mex/local/` estén ignorados por Git.

Las estructuras de Markdown existentes siguen siendo válidas y las lecturas del Graph nunca migran un almacén de forma implícita. Los almacenes compatibles con schema-v2 y los almacenes completos con schema-v3 pueden actualizarse mediante una reparación explícita; los almacenes con schema-v1, parciales, ambiguos, malformados o corruptos requieren una reconstrucción. Sigue la acción exacta que indique `mex graph status`. No añadas una regla general para ignorar `.mex/`: ocultaría la memoria canónica que tu equipo debe compartir.

> [!WARNING]
> Actualiza a todo el equipo a **0.8.1 antes de compartir nuevos Relays abiertos al equipo**, que usan schema-v4. Los Relays existentes con schema-v1 a schema-v3 siguen siendo compatibles, y los traspasos con destinatarios concretos siguen usando schema-v3. MEX requiere Node 22.5 o posterior con [SQLite FTS5 disponible](COMPATIBILITY.md#sqlite-fts5). Quienes usen Node 20 deben permanecer en MEX 0.6.3 hasta que puedan pasar a una compilación compatible de Node.

<a id="privacy-and-trust-model"></a>

## Privacidad y modelo de confianza

MEX no sube sus registros canónicos, Graph, índice de la Wiki, borradores, selección de identidad ni sesiones de Hub a un servicio de MEX. No ofrece transporte automático entre miembros del equipo: el contenido se comparte mediante las operaciones habituales de Git que tú realizas. Hub escucha en la interfaz de loopback y la capa de recuperación local de MEX no requiere credenciales de modelos.

MEX tiene **telemetría seudónima de uso de la CLI y del Hub**, activada por defecto salvo que la desactives. Registra nombres de comandos, resultados, acciones explícitas del Hub, categorías de páginas y resultados de trabajos. Ambos usan un UUID aleatorio de instalación para medir el uso recurrente. Cuando están disponibles, también se envían el UUID existente del scaffold para estimar el uso compartido de un proyecto y los nombres de las herramientas de IA seleccionadas en su configuración; estos datos no identifican al agente que ejecuta el comando ni demuestran el tamaño de un equipo. Quien tenga acceso a la configuración puede asociar el UUID del scaffold con ese proyecto. No se envían nombres, remotos de repositorios, argumentos, rutas, contenido, búsquedas ni datos de contacto. El servicio receptor puede observar los metadatos habituales del transporte. Una cola local limitada y una espera breve al terminar la CLI permiten posponer el envío sin cambiar el resultado del comando.

Consulta o desactiva la telemetría con:

```bash
mex telemetry inspect
mex telemetry status
mex telemetry disable
```

También puedes desactivarla con `MEX_TELEMETRY=0` o `DO_NOT_TRACK=1`. Consulta la [política de telemetría](TELEMETRY.md) para conocer los controles y el contenido exacto que se envía. Los agentes de programación conectados a MEX pueden tener su propio comportamiento de red y telemetría; eso depende de esas herramientas, no de MEX.

<a id="what-mex-is-not"></a>

## Lo que MEX no es

MEX 0.8 **no** ofrece:

- un Hub alojado en la nube ni sincronización de conocimiento mediante un servicio alojado;
- notificaciones en directo, presencia ni chat en tiempo real;
- preparación automática de archivos para commit, commits, pushes ni pulls de Git;
- autenticación, autorización del repositorio ni RBAC;
- gestión de tareas al estilo de Jira;
- una base de datos SQLite compartida de Code Graph o Wiki;
- una prueba automática de que un modelo utilizó correctamente el contexto recuperado;
- un motor de búsqueda semántica o vectorial: la búsqueda de la Wiki es de texto completo y la recuperación del Graph es léxica o estructural;
- edición general de la Wiki a través de Hub;
- un servidor MCP ni un paquete MCP publicados: el workspace de código fuente no forma parte de la oferta pública de 0.8;
- funciones que solo aparecen en planes futuros o documentos de diseño.

MEX mantiene la memoria del equipo en archivos del repositorio y proporciona flujos locales de recuperación y revisión. Git y las herramientas de ingeniería existentes se encargan de la distribución, el acceso y la revisión del código.

<a id="explore-further"></a>

## Más información

- Lee las [notas de la versión MEX 0.8](https://github.com/mex-memory/mex/releases/tag/v0.8.0).
- Consulta la [guía de entorno de ejecución y compatibilidad](https://github.com/mex-memory/mex/blob/v0.8.0/COMPATIBILITY.md) y la [política de seguridad](https://github.com/mex-memory/mex/blob/v0.8.0/SECURITY.md).
- Revisa la [matriz de compatibilidad del Code Graph](https://github.com/mex-memory/mex/blob/v0.8.0/docs/code-graph-support.md).
- Consulta el [modelo de extractores y las relaciones compatibles](https://github.com/mex-memory/mex/blob/v0.8.0/docs/extractors.md).
- Lee los [resultados del benchmark de recuperación del Code Graph](https://github.com/mex-memory/mex/blob/v0.8.0/evaluate/RESULTS.md), incluida la comparación evaluada a ciegas frente a una búsqueda de archivos convencional.
- Inspecciona la CLI localmente con `mex capabilities --json` y `mex commands`.
- Únete a la [comunidad de MEX en Discord](https://discord.gg/FEdNsQ4Qt4) o visita [mexmemory.com](https://mexmemory.com).
