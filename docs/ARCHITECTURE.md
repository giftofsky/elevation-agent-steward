# Architecture

This document explains how `agent-steward` (plugin id
`opencode-windows-scheduler`) is put together: the process
model, the modules, the data model and the extension points.

- [Design principles](#design-principles)
- [Execution model](#execution-model)
- [Data flow](#data-flow)
- [Modules](#modules)
- [Scheduling backends](#scheduling-backends)
- [Run wrapper](#run-wrapper)
- [History, metrics and recovery](#history-metrics-and-recovery)
- [Cost controls and tool surface](#cost-controls-and-tool-surface)
- [Chains, retries and DAG](#chains-retries-and-dag)
- [Matrix builds](#matrix-builds)
- [Workspaces](#workspaces)
- [Triggers](#triggers)
- [Storage](#storage)
- [Interfaces](#interfaces)
- [Localization](#localization)
- [Security model](#security-model)
- [Extension points](#extension-points)

The target execution loop — registration, OS trigger, run wrapper, Quality Gate and
ledger — is described in [docs/EXECUTION-LOOP.md](./EXECUTION-LOOP.md).

## Design principles

1. **The OS scheduler owns time.** The plugin never keeps a timer in memory for cron
   jobs. Every recurring task becomes a real OS entry (Task Scheduler, launchd,
   crontab), so jobs survive reboots and closed editor windows.
2. **The host process owns the UI.** Agent tools, the sidebar GUI, the RPC layer and the
   dashboard live inside the OpenCode plugin host. They are stateless wrappers around
   the database and the OS scheduler.
3. **Runs are independent processes.** A job executes `opencode run` through a wrapper
   that enforces timeout, single-instance locking, pre/post hooks and a Quality Gate.
   The wrapper reports the result back to the database, not to the plugin host.
4. **One source of truth for definitions is SQLite.** OS entries are derived artifacts:
   they can always be recreated from the database with export/import.
5. **Local first.** No network services, no telemetry, no accounts by default. The dashboard binds
   to localhost only. Local AI triage (Ollama) is optional and connects only when explicitly enabled
   via `manage_local_ai`.

## Execution model

agent-steward is an execution engine with optional trigger registration — not a
scheduler with extras attached. Four kinds of entry lead into the same execution
path, and the OS scheduler is only one of them (CONCEPT §5, §8):

| Entry | Examples | Goes through the OS scheduler? |
| --- | --- | --- |
| ad-hoc (no OS registration) | GUI · CLI · TUI · RPC (`run_mission`) | No |
| internal orchestration (core-driven, no OS) | chains · DAG dependents · retries · matrix continuation · escalation · resume after pause/crash | No |
| registered triggers | `cron` / `once` | Yes — registered with Task Scheduler / launchd / crontab |
| registered, in-process | `file` / `git` / `mcp-event` / webhook | No — watched inside the plugin process |

Orchestration (chains, DAG, retries, matrix, escalation) is performed by the core
and the recorder through **direct wrapper launches**, never by the OS scheduler.
The OS scheduler is responsible only for firing registered `cron`/`once` ticks.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ENTRIES                                                             │
│                                                                     │
│  ad-hoc (no OS registration)                                        │
│    GUI · CLI · TUI · RPC (`run_mission`)                             │
│                                                                     │
│  internal orchestration (core-driven, no OS)                        │
│    chains · DAG dependents · retries · matrix continuation ·        │
│    escalation · resume after pause/crash                            │
│                                                                     │
│  registered triggers                                                │
│    cron / once ────────────────▶ OS scheduler registration          │
│    file / git / mcp-event / webhook ▶ in-process watchers           │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │                              │
               ▼                              ▼
   ┌───────────────────────┐      ┌───────────────────────────────────┐
   │ OS scheduler          │      │ Execution core                    │
   │ optional lane —       │      │ createRun → plan → route →        │
   │ cron/once ticks only  │      │ execute → GATE → ledger           │
   │ schtasks / launchd /  │      │ (today: run journal, resume, DLQ, │
   │ crontab (+ at;        │      │  router; full mission runtime —   │
   │  sleep fallback when  │      │  sprints 32/38)                   │
   │  at is unavailable)   │      └───────┬───────────────┬───────────┘
   └──────────┬────────────┘              │ direct launch │ registered
              │ fires                     │ (bypasses OS) │ tick
              │                           ▼               ▼
              │   ┌──────────────────────────────────────────────────┐
              └──▶│ Run wrapper (.cmd+.ps1 / .sh) — ONE execution    │
                  │ unit for BOTH lanes:                             │
                  │  • schedule-gate (child node process): poll-mode │
                  │    IANA timezone, launch window, defer/force     │
                  │    markers — BEFORE the lock                     │
                  │  • lock (.lock / .lock.d) + timeout watchdog     │
                  │  • env/secrets + permission policy               │
                  │    (OPENCODE_CONFIG_CONTENT)                     │
                  │  • opencode run --auto → Quality Gate →          │
                  │    before/after hooks → one-shot cleanup (POSIX) │
                  └─────────────────────┬────────────────────────────┘
                                        │ --start / --finish
                                        ▼
                  ┌──────────────────────────────────────────────────┐
                  │ recorder process (core/record-history.js)        │
                  │  • history / metrics → SQLite                    │
                  │  • retries ─────────────────┐                    │
                  │  • chains / DAG dependents ─┼─▶ direct wrapper   │
                  │  • matrix aggregation ──────┘   launches (no OS) │
                  │  • session rotation                              │
                  │  • one-shot cleanup (Windows) ─▶ OS scheduler    │
                  │  • notifications: webhook / Telegram / toasts    │
                  │    (+ async triage, optional local model)        │
                  └──────────────────────────────────────────────────┘
```

| Process | Lifetime | Notes |
| --- | --- | --- |
| Plugin host | OpenCode session | agent tools and RPC; sidebar GUI and TUI; dashboard HTTP server (UI, `/api/*` with origin guard, `/api/hooks` HMAC, `/metrics`); in-process triggers (chokidar file watcher, git polling, MCP events, webhook ingestion); durable-run executor (resume / pause / DLQ); startup recovery |
| OS scheduler | system service | optional lane for `cron`/`once` ticks only: Task Scheduler (Windows), launchd (macOS), crontab + `at` (Linux; detached `sleep` fallback when `at` is unavailable) |
| Run wrapper | one per run | the single execution unit; direct launches and registered ticks execute the same wrapper, so direct runs get the same gate, lock, timeout, hooks and policy |
| schedule-gate | seconds, child of the wrapper | separate `node` process; exit 3 = "not now" (skip or postpone), fail-closed on invalid cron |
| recorder | seconds, one per run | short-lived `node` process started by the wrapper with `--start` / `--finish`; independent of the plugin host |

### Why direct launches are safe

A common question: does `run_task_now` / chain continuation skip the safety
machinery? No. Both lanes converge on the same wrapper, so every direct run still
passes through the schedule gate, takes the lock, runs under the timeout watchdog,
loads env/secrets with the task permission policy, and records history through the
recorder. The only difference is *who starts the wrapper*: the OS scheduler or the
core.

### Unified execution path (AC-1)

`src/core/execution.ts` is the single core path for both registered tasks and
ad-hoc missions: `createRun → plan → route → execute → GATE → ledger`. The origin
(`registered` or `ad-hoc`) changes where the context comes from, not what happens
next.

- **`RunContext` (AC-1.1)** — entry, trigger, task name, mission/prompt, cwd,
  profile (model, session policy, workspace) and safety contract (permission
  policy, allowed/denied tools). `createRegisteredRunContext` builds it from a
  task definition; `createAdHocRunContext` from a free-form mission, defaulting
  to `ad-hoc` / `new` session / `hybrid` policy. `validateRunContext` rejects
  empty fields, unknown policies and tools listed as both allowed and denied.
- **Plan and dry-run trace (AC-1.3)** — `buildExecutionPlan` either uses the
  explicit task type or asks the heuristic planner to decompose the mission, then
  routes every step through the capability map. `describeExecutionPlan` prints the
  ordered steps, their local/cloud/review targets and routing source without
  creating a run row, so the same plan can be inspected before execution.
- **Executor abstraction (AC-1.2)** — `StepExecutor` advertises which routes it
  supports and receives `{ step, context, plan }`. `createOpenCodeExecutor`
  adapts the OpenCode CLI, but the core no longer depends on that transport:
  another executor can serve the same plan.
- **Execution and GATE (AC-1.4)** — `executeExecutionPlan` creates one ledger run,
  executes steps through the journal (so retries, leases and crash recovery still
  apply), calls the optional GATE after each result and stops on the first
  failure. Steps routed to review/explore are recorded as `skipped` with the
  routing reason instead of being silently dropped.

The test `test-execution-pipeline.mjs` drives a registered task and an ad-hoc
mission through the same executor, including a rejecting GATE and a skipped
review step.

### Ad-hoc mission runtime (AB-8)

`src/core/mission.ts` turns a one-off request into a `RunContext` without
registering anything in the OS scheduler. The same entry point is exposed by
the RPC method `run_mission` (not registered as an agent tool), the CLI command `agent-steward run`
and the GUI panel «Ad-hoc миссия».

- **MissionSpec (AB-8.1)** — `prompt` is required; `cwd`, `taskName`,
  `taskType`, `model`, `session` (`new` / `reuse` / `last`), `sessionId`,
  `timeoutSeconds` (1–86400), `gate`, `gateTimeoutSeconds`, `policy`
  (`hybrid` / `secure` / `legacy`), `allowedTools`, `deniedTools` and `dryRun`
  are optional. `normalizeMissionSpec` trims the prompt, makes `cwd` absolute,
  rejects unknown policies/timers/sessions and tools listed as both allowed and
  denied. The default task type is `mission`, routed statically to
  `local`/`direct`.
- **Safety contract** — the mission is a normal `RunContext` with its own
  permission policy and tool lists. It does not bypass the GATE, budget, audit
  or ledger; the wrapper receives the gate command and permission config just
  like a registered task. An in-process lock keyed by the resolved workspace
  rejects a second mission in the same directory
  (`В workspace … уже выполняется миссия …`).
- **Planning and dry-run** — `buildExecutionPlan` + `describeExecutionPlan`
  produce the same trace as registered runs. `dryRun: true` returns the plan
  with `status: "planned"` and does not create a ledger row.
- **Execution (AB-8.2/8.3)** — without an injected executor the mission writes
  the prompt file, log, lock and wrapper (`writeWrapperCmd` on Windows,
  `writeBashWrapper` on POSIX), spawns the wrapper with a hard timeout, and
  feeds its output into `executeExecutionPlan`; the run is stored with
  `metadata.adHoc = true` and tasks are never created in Windows Task Scheduler,
  launchd or crontab. An injected `StepExecutor` is used by tests and
  alternative transports.
- **Results** — `MissionResult` reports `success`, `dryRun`, `runId`, `status`
  (`planned` / `passed` / `failed`), `steps`, `error`, `logFile` and the
  human-readable plan description. `run_mission` returns the same data minus
  raw step output.

The test `test-mission-run.mjs` covers dry-run (no ledger row), a successful
ad-hoc run, executor failure, the workspace lock, input validation and a static
check that the mission path never imports the OS scheduler.

### Data: one SQLite per profile

Each profile has its own plugin directory, its own SQLite database, its own OS-task
namespace and its own dashboard port. `default` keeps 3782 (fallback 4782); a named
profile gets the first free port from 3783 upward when it is created, recorded in its
`profile.json`, and never one already reserved by `default` or another profile. Every
dashboard response carries `x-plugin-profile`, so a second profile neither reuses
another profile's server nor treats it as a zombie.

`SCHEMA_VERSION` is currently **14**; migrations are additive and idempotent,
applied through `PRAGMA user_version` on open. Step 11 adds functional indexes
`idx_history_task_lower` / `idx_history_status_lower` for `getHistory()` filters.

| Tables | Purpose |
| --- | --- |
| `tasks`, `workspaces`, `templates`, `settings` | definitions and configuration |
| `history`, `metrics` | run outcomes, duration / tokens / cost, analytics; v8 adds `owner_pid` / `owner_host` / `owner_started_at` so recovery can keep live runs |
| `audit_log` | mutation journal (who / what / when / which interface) |
| `git_state` | git-trigger heads and polling state |
| `notification_dedup`, `notification_embeddings` | rule-based and embedding dedup; tokenizer emits overlapping CJK bigrams so CJK messages get non-zero vectors |
| `runs`, `run_steps`, `run_dlq`, `run_injections` | durable runs: state machine, step journal, dead-letter queue, pause-time context injections; v9 adds `owner_id` / `lease_until` to `run_steps` |
| `capability_map` | router layer 2: task type → model / success rate / costs / last runs; v10 adds `first_pass_count` |

### Known limitations (execution)

- AD-1.1: the scheduler source is selectable via `nativeScheduler.mode`
  (`polling` / `native` / `auto`) in `settings.json`. `auto` switches to the
  host-native trigger only when the host advertises the capability
  (`OPENCODE_NATIVE_SCHEDULER`, caps `ledger,dlq,budgets,approval,execution-loop`),
  otherwise it stays on `schtasks`/`cron`/`launchd`. The native backend only
  registers in the same `TaskRegistry` and delegates the trigger to the existing
  execution loop; ledger, DLQ, budgets and approval are never reimplemented in
  the host. See `docs/NATIVE-SCHEDULER.md` and `test-native-scheduler.mjs`.

- AD-1.2: the external surface is versioned as
  `agent-steward.external-contract@1.0` (pipeline YAML v1 + SQLite `scheduler.db`
  schema 14). MCP, API, pipeline and native-scheduler entries all resolve to the
  same `RunContext -> buildExecutionPlan -> executeExecutionPlan` path; no second
  engine is introduced. A golden fixture pins the descriptor hash
  (`1e05a35afdc1feff`) and `test-external-contract.mjs` checks plan parity for
  every entry. See `docs/EXTERNAL-CONTRACT.md`.

- Startup recovery (`recoverInterrupted*`) marks unfinished rows as `error` without
  a liveness check, so a plugin restart during a live run may finalize it early.
  v8 added `owner_pid` / `owner_host` / `owner_started_at` and
  `recoverStaleRunningOnRecorderStart` closes stale rows at recorder start, but a
  crashed wrapper can still leave history `running` until the task timeout
  (**PL-124**).
- Orphaned runs (**PL-138**) are not finalized in-place: `runTaskEntry()` reaps them
  at the next launch, before the isolation gate. A run is considered orphaned when
  its task log has not been modified for `AGENT_STEWARD_STALE_RUN_LOG_SEC` seconds
  (180 by default); the record is closed as `error` with an explicit-retry reason.
  When a live but idle agent keeps the wrapper open (**PL-134**), the Windows
  completion watcher writes the reason («агент не отвечает», idle window and no
  log/CPU progress) into the marker and `Write-Log`, while keeping PL-124 exit
  compatibility (the report is already written, exit code stays 0).
- Durable steps currently execute through the same wrapper machinery. The runner
  abstraction (`runner.ts` / `runner-docker.ts` / `runner-ssh.ts` / `runner-run.ts`,
  fail-open to local) is wired into the production path through the `AgentInvoker`
  seam (P-3.2): explicit invocations use `resolveRunner(...).runner.execute(...)`.
  Since EX-1.1 the runner is selectable declaratively — via the `runner` field of
  the task schema / RPC `create_task`, `steward add --runner local|docker|ssh`
  (with `--runner-image/--runner-host/--runner-user/--runner-opt-out`), and
  `run_mission` / ad-hoc runs. The choice is baked into the registered OS-scheduler
  wrapper as an encoded `runner-run.js` bridge, so the scheduled run uses the same
  transport as the interactive one. Invalid, missing or unavailable runner config
  degrades to `local` (fail-open); `docker`/`ssh` additionally require the image/host
  and the corresponding binary. Since EX-1.2 the role rotation and
  post-mortem policies from `src/core/agents.ts` are part of the execution loop
  itself: every step receives `assignRole(...)` (`worker` → `reviewer`) through
  `StepExecutionInput.agentRole`, and failures are classified by `postmortem()`
  and recorded in `ExecutedStep.postmortem`. The public re-export remains for
  API compatibility but is no longer the only way to enable the policies.
  Self-correcting retry is enabled explicitly with
  `ExecutePlanOptions.agentPolicies.retry.maxAttempts > 1`; the default is one
  attempt, so existing runs stay deterministic. Secrets, quota and unknown
  causes are never retried. Advanced primitives in `agents-advanced.ts` are
  still pure helpers and do not change the loop. EX-1.3 proves transport
  independence: `test-execution-pipeline.mjs` runs the same immutable plan and
  mission through two `StepExecutor`s with different descriptors (direct
  `opencode` and `mission-wrapper`) and asserts byte-identical step results and
  per-step traces; only `runId` and transport identity differ.
- `checkBudgetGate` / `checkRunBudgetGate` are called at tool/RPC/manual entry
  points and on the registered OS-scheduler path via the wrapper's `--budget-gate`
  check (B-1.1, PL-125); an over-limit run is recorded as `skipped` with a reason.
- Approval A-1 is closed and runs through `approval-api.ts`, but mission plans with
  deferred effects still need a manual restart after approval.
- Staged LoRA (LP-1.1/LP-1.2) does not train weights in this repository. It builds
  a versioned ledger-only dataset, validates it, and gates an external offline
  adapter artifact with mandatory eval against the acceptance baseline. The
  stored `weightsRef` is a symbolic link, online learning is forbidden by format,
  and promotion requires a passing eval plus an explicit decision. LP-1.3 adds
  rollout metadata: shadow activation has zero traffic share, canary is limited
  to 5% and requires a passing shadow comparison, rollback zeroes both shares and
  restores the baseline snapshot. No adapter was routed to full traffic in the
  measured run. Measured baseline snapshot (2026-11-25): 183 rows, 122 cases,
  success rate 0.2593, first pass rate 0.4208, net economy 2.5829 USD.

## Data flow

**Create a task**

1. Agent tool / GUI / import calls `schedulerCreateTask(...)`.
2. Definitions are validated (cron, workspace path, matrix rules), a prompt file and a
   wrapper script are written under the plugin directory; if the task's workspace has
   env variables, `<PLUGIN_DIR>/env/<sanitized>.env` is written (mode `0600` on POSIX).
3. An OS entry is created through the platform backend.
4. The definition is stored in `tasks.definition_json`.

**Run a task**

1. The OS scheduler starts the wrapper.
2. When the task carries a schedule gate (poll-mode cron, foreign timezone or a
   launch window), the wrapper first runs `node dist/core/schedule-gate.js`: it
   re-checks the extended cron in the task's zone, and if now is outside the
   launch window it waits until the window opens (postpone, deduplicated by a
   defer-file) or exits with code 3 so the wrapper skips silently.
3. The wrapper acquires the lock (`locks/<task>.lock`), writes the log
   (`logs/<task>.log`), loads workspace env from `<PLUGIN_DIR>/env/<sanitized>.env`
   (Windows `-EnvFile`, POSIX `set -a; . "$ENV_FILE"; set +a`) before starting
   `opencode run` with the prompt file. The prompt is passed after `--`, so a
   prompt starting with `-` is never parsed as an option. Output is streamed to the log.
4. When the process ends, the wrapper enforces the timeout result, runs the Quality
   Gate and the post-flight hook. On Windows the watchdog snapshots the process tree
   via CIM and falls back to WMI, then to `tasklist`/`Get-Process`; when no tree data
   is available at all it fails closed and kills the root process tree with
   `taskkill /F /T`.
5. The wrapper calls `node dist/core/record-history.js --finish ...` with status,
   duration, tokens, cost, model and hook results.
6. The recorder writes `history` and updates `metrics`, then evaluates retries, task
   chains, DAG dependents and matrix continuation.

**Read state**

`collectTasksView()` (shared by tools, RPC and GUI) merges definitions, the latest
history record and metrics into a `TaskItem`. Matrix parents get an aggregated status
from their clones instead of their own last run.

## Router (3-layer)

The router decides *how* each task step executes — direct local call, MCP transport, or
cloud model — without involving a model for known step types.

### Слой 1 — статические правила (0 токенов, мгновенно)

Таблица соответствий тип задачи → транспорт + исполнитель. Большинство операций
известны заранее, модель не нужна.

| Тип задачи | Транспорт | Исполнитель |
| --- | --- | --- |
| `read_file` | direct | local |
| `write_file` | direct | local |
| `run_tests` | direct | local |
| `apply_diff` | direct | local |
| `github_create_pr` | mcp | local |
| `jira_update_task` | mcp | cloud |

Агент хочет прочитать файл → роутер смотрит в таблицу → видит `direct + local` →
выполняет напрямую, без MCP, без модели.

Реализация (Спринт 36.5.a): `src/core/router/rules.ts` — замороженная таблица
`STATIC_ROUTE_RULES`, `routeStaticStep(taskType)` (нормализует `Run Tests` /
`run-tests` → `run_tests`), `isStaticTaskType`, `listStaticRouteRules`.
Модуль не импортирует ни БД, ни модель, ни транспорт, поэтому горячий путь
физически не может стоить токенов; неизвестный тип возвращает `undefined` и
передаётся слою 2. Покрытие — `test-router-rules.mjs` (22 проверки, включая
1000 маршрутизаций быстрее 50 мс).

### Слой 2 — Capability Map (0 токенов, быстро)

SQLite-таблица `task_type → model / success_rate / first_pass_rate /
avg_cost / avg_time / last_10_runs`. Обучается на исходах гейта
(CONCEPT §9 learning loop).

- `effective_success_rate ≥ 0.85` → маршрут локально
- `effective_success_rate ≤ 0.30` → эскалация в облако или «нужно ревью»

`effective_success_rate = 0.7 × decayed_success_rate + 0.3 × first_pass_rate`.
`decayed_success_rate` считается по `last_10_runs` с half-life 8 исходов
(свежий исход весит 1, каждый предыдущий — вдвое меньше на каждые 8 шагов),
поэтому недавние провалы быстро перевешивают старые успехи. `first_pass_rate`
— доля успехов, достигнутых с первой попытки (`attempts = 1`); явный флаг
`firstPass` позволяет переопределить это для конкретного исхода.

Это и есть learning loop: роутер учится на гейтах и становится точнее без затрат
токенов на само решение.

Реализация (Спринт 36.5.b, B13): `src/db/capability-repo.ts`, таблица
`capability_map` (`SCHEMA_VERSION = 14`). `recordCapabilityOutcome` обновляет
счётчики (`runs_total`, `runs_passed`, `first_pass_count`), кумулятивный
`success_rate` и скользящие средние стоимости/времени, хранит `last_10_runs`
(JSON, новые справа). `decideCapabilityRoute` решает по правилам:
меньше `MIN_RUNS_FOR_DECISION = 3` исходов → `explore` (решает слой 3),
`effective_success_rate ≥ 0.85` → `local`, `≤ 0.30` → `cloud`, между порогами →
`review`. Пороги передаются параметром, поэтому политика меняется без миграции
данных. При миграции v9 → v10 legacy-записи получают
`first_pass_count = runs_passed` (старые успехи считаются успехами с первой
попытки). Покрытие — `test-capability-map.mjs`.

EV-2.3: если данных мало и карта выдаёт `explore`, включается **capped
explore-бюджет** и детерминированный bandit вместо бесконечного research.
`decideExploreBandit` в `src/core/router/capability-math.ts` — чистая функция:
ε-greedy с FNV-1a-хэшем `taskType` (без `Math.random`), local-first при равных
наградах; лимиты по умолчанию `maxRuns=3`, `maxTokens=20000` на UTC-окно.
Жёсткая граница: при исчерпании токенов или запусков маршрут становится
`review` с причиной `explore-token-budget-exhausted` /
`explore-budget-exhausted`, у границы — даунгрейд на `local`
(`explore-budget-near-limit`). Расход хранится в `settings` под ключом
`explore_budget_v1` (`getExploreUsage`/`consumeExploreUsage` в
`src/db/capability-repo.ts`), списывается **до** старта исполнителя, миграции
схемы не требует. Покрытие — `test-router.mjs`, `test-router-dispatch.mjs`,
`test-execution-pipeline.mjs`.

Деталь 3.19 / S-2: формулы и пороги вынесены в чистый модуль
`src/core/router/capability-math.ts` (без БД и `@opencode-*`). Его используют и
SQLite-карта, и публичный сабпат `agent-steward/router`, который хранит обучение
в памяти и переносит состояние детерминированным снимком (`version: 1`). Это
позволяет обучать роутер вне процесса плагина и проверять качество маршрутов
без durable-слоя. Подробности — [docs/ROUTER.md](ROUTER.md).

### Слой 3 — локальная модель (только декомпозиция и неоднозначность)

Модель не маршрутизирует каждый шаг. Она только:
1. Разбивает миссию на шаги с типами (планирование);
2. Разрешает неоднозначность (Explore-режим, когда в Capability Map нет данных).

После этого каждый шаг проходит через Слой 1 и Слой 2. Слой 3 — **декомпозиция
миссии**, а не маршрутизация шага: он решает, *что* делать, но никогда не
выбирает, *где* исполнять. `RouteSource` в `src/core/router/dispatch.ts:15`
принимает только `static` и `capability` — значения `model`/`planner` в нём
нет, и `routeStep` не импортирует `planner`.

**Реализация (Спринт 36.5.c):** `src/core/router/planner.ts`. `planMission(mission, { decomposer, maxSteps })` вызывает декомпозер — локальную модель — один раз на миссию и нормализует типы через `normalizeTaskType`; без декомпозера работает `decomposeHeuristically` по ключевым словам, без сети и модели. `planMissionSync` — вариант для синхронных мест. Шаг плана содержит только `stepName` и `taskType`, маршрут по-прежнему выбирают слои 1–2; типы вне статических правил собираются в `ambiguousTaskTypes` для `decideCapabilityRoute`. Пустая миссия, пустой или битый план модели — ошибка, а не молчаливый план. Покрытие — `test-planner.mjs`.

**Реализация (Спринт 36.5.d):** `escalateAfterGate(current, gate)` в `src/core/router/escalation.ts` решает судьбу шага по одному флагу `passed` и таблице переходов `local → cloud → review → blocked`. Модуль не импортирует ни БД, ни модель, ни сеть: это чистые функции (`nextGateTarget`, `isEscalationExhausted`, `escalationChain`), поэтому 1000 решений стоят доли миллисекунды. Переход в `blocked` означает, что автоматических уровней больше нет и нужен человек.

Слои 1–2 собираются в `routeStep(taskType, thresholds, options?)` из `src/core/router/dispatch.ts`: сначала статическое правило (0 токенов), затем Capability Map. При `options.exploreBudget.enabled` и решении карты `explore` включается bandit из EV-2.3: маршрут `local`/`cloud`/`review` с причиной bandit'а и полем `exploreBandit`; без опций поведение прежнее — `explore` без транспорта и исполнителя. Для `review` маршрут по-прежнему возвращается без транспорта и исполнителя — исполнять пока нечего. Модуль не импортирует `planner`, поэтому известный тип задачи не может случайно дойти до модели; это закреплено тестом `test-router-dispatch.mjs`, который также проверяет, что статика не оставляет записей в `capability_map` и работает ещё до инициализации БД.

### Эскалация

При провале гейта роутер эскалирует в облако **по правилу**, без участия модели.

---

## Modules

| Path | Role |
| --- | --- |
| `src/index.ts` | Plugin lifecycle, 34 agent tools (filtered by tool profile), 61 RPC handlers, task CRUD, view assembly; `dry_run`, `compact` history and short core-tool schemas |
| `src/core/tool-profile.ts` | Tool profiles `core` (11 read/control tools incl. `emit_event` and `delete_task` for stale-task cleanup), `admin` (+9 advanced/manage tools), `all` (full 34); `AGENT_STEWARD_TOOL_PROFILE` selects the surface |
| `src/rpc.ts` | JSON-schema contracts for every RPC method |
| `src/gui.tsx` | OpenCode sidebar panel (SolidJS, built to `gui-experimental.cjs`) |
| `src/server.ts` | Local web dashboard HTTP server and HTML rendering |
| `src/skill.ts` | Loads and registers the bundled agent skill |
| `src/task-transfer.ts` | Export/import, validation, `MatrixConfig` types |
| `src/profiles.ts` | Profile directory resolution: per-profile plugin dir (base for `default`, `<base>/profiles/<name>` for named profiles); profile name, marker, port, create/delete/switch |
| `src/workspaces.ts` | Workspace registry and path validation; env pairs and `.env` file resolution with secret masking |
| `src/templates.ts` | Reusable task templates |
| `src/settings.ts` | Plugin settings: notifications, history retention, audit, interface locale (`auto`/`ru`/`en`/`zh`/`tr`) and last known UI locale, local AI/triage |
| `src/i18n.ts` | Interface locale mode (`auto` default, follows OpenCode; `ru`/`en`/`zh`/`tr` explicit), BCP 47 mapping, four JSON catalogs in `locales/`, ICU subset (`{param}`, `plural`) via built-in `Intl`, fallback catalog `en` |
| `src/notifications.ts` | Multi-channel delivery (webhook, Telegram, native OS) with retries/backoff, templates, task filters, quiet hours, matrix and stuck-clone notifications, daily/weekly digest |
| `src/core/telegram.ts` | Telegram Bot API `sendMessage`: parse-mode escaping, dashboard link, token validation and masking |
| `src/core/native-notify.ts` | Native OS notifications: Windows Toast (PowerShell/WinRT), macOS `osascript`, Linux `notify-send`; no external dependency |
| `src/core/secrets.ts` | Encrypted secret store (AES-256-GCM, `secrets.key` 0600, `${secret:NAME}` refs, redaction) |
| `src/core/audit.ts` | SQLite audit journal (`audit_log`), redacted details, retention cleanup |
| `src/history.ts` | History model and status types |
| `src/version.ts` | Runtime plugin version (reads package.json) |
| `src/core/retention.ts` | Daily history prune and incremental vacuum |
| `src/core/analytics.ts` | Pure 14-day analytics and CSV export |
| `src/core/savings.ts` | Counterfactual savings report (`net_savings_usd`) for analytics/CSV |
| `src/core/reliability-scorecard.ts` | Public reliability metric: objective gate outcomes, first-pass rate and saved-token share with methodology and sample size (S-3) |
| `src/core/recipes.ts` | Gate-passed recipe library: pipeline YAML plus objective gate evidence, pure `verifyRecipe()`/`verifyAllRecipes()` (S-4) |
| `src/core/verified-chat.ts` | Verified chat: answer only when an objective gate, source quote or gate-passed recipe is present; refusal otherwise (S-5) |
| `src/core/scaffold.ts` | One-command scaffolding from gate-passed recipes: verified recipe to pipeline YAML, README and gate script (S-6) |
| `src/core/execution.ts` | Execution plan, step executor, quality gate, ledger writes and escalation |
| `src/core/mission.ts` | Ad-hoc mission → `RunContext`, approval and budget gates before `createRun` |
| `src/core/scheduler/` | Platform backends, registry, logs |
| `src/core/ps-wrapper.ts` | PowerShell wrapper template and `.cmd` generation |
| `src/core/wrappers/bash.ts` | POSIX wrapper template |
| `src/core/record-history.ts` | Recorder: history, retries, chains, DAG, matrix continuation, usage fallback to OpenCode DB and offline estimate |
| `src/core/opencode-usage.ts` | Read-only OpenCode DB usage lookup (±2 s window around the run) |
| `src/core/usage-surface.ts` | Deterministic offline token/cost estimate when provider usage is absent (`estimateRunUsage`) |
| `src/core/budget.ts` | Daily/weekly budget report and `checkBudgetGate`, 14-day `tokenEfficiencyScore` for `get_metrics` |
| `src/core/approval-api.ts` | Approval queue facade (`list_approvals` / `decide_approval`) and auto-restart of approved plans |
| `src/core/agents.ts`, `src/core/agents-advanced.ts` | Agent executor abstraction and advanced routing/execution paths |
| `src/core/runner.ts`, `src/core/runner-docker.ts`, `src/core/runner-ssh.ts`, `src/core/runner-run.ts` | Runner abstraction and Docker/SSH implementations (`resolveRunner`, fail-open to local; wired into `AgentInvoker.invoke` — P-3.2 and into scheduled wrappers via the `runner-run.js` bridge — EX-1.1) |
| `src/core/environment.ts` | Environment resolver for runner/executor selection |
| `src/core/matrix.ts` | Fan-out, aggregation, sync, cancel, orphan cleanup |
| `src/core/dry-run.ts` | Pipeline simulation (topological order, commands, cwd, roles and estimates from recent runs; no execution) |
| `src/core/lock.ts` | Single-instance lock manager |
| `src/core/file-watcher.ts` | chokidar-based file triggers |
| `src/core/local-ai.ts` | Local AI triage: LLM classifier with rules fallback, shadow mode, fail-open, manage_local_ai backing |
| `src/core/cron-to-schtasks.ts` | Cron → Task Scheduler translation |
| `src/core/schedule-v2.ts` | Extended cron parser/matcher, timezone math, launch windows, poll-mode decisions |
| `src/core/schedule-gate.ts` | Wrapper-side gate: cron re-check (poll mode), window postpone, defer-file |
| `src/db/` | SQLite access: schema, migrations, repositories, recovery; `runs-repo.ts` keeps durable `runs`/`run_steps` state, `run-journal.ts` writes transitions around each step, `run-resume.ts` continues a crashed chain, `step-idempotency.ts` replays steps by key, `run-dlq.ts` parks deterministically failed steps |
| `src/core/router/rules.ts` | Router layer 1: static rules task type → transport + executor, normalization, no imports (0 tokens) |
| `src/db/capability-repo.ts` | Router layer 2: Capability Map - gate outcomes per task type, cumulative and decayed success_rate, first_pass_rate, moving averages, last 10 runs, threshold decision |
| `src/core/router/planner.ts` | Router layer 3: mission decomposition (model once per mission) and heuristic fallback, steps carry type only, routing stays in layers 1-2 |
| `src/core/router/dispatch.ts` | Router assembly: `routeStep` runs layer 1 then layer 2 and returns transport/executor, never imports the planner |
| `src/core/router/escalation.ts` | Gate failure escalation `local → cloud → review → blocked` by pure transition table, no DB, no model |
| `src/shared/jobs-view.ts` | Task view shared by the GUI and dashboard |

## Scheduling backends

`scheduler/registry.ts` keeps the mapping between a task name and its OS entry.
`scheduler/index.ts` picks a backend from `process.platform`.

| Platform | Backend | Notes |
| --- | --- | --- |
| Windows | `schtasks.exe` | Cron is translated to `MINUTE/HOURLY/DAILY/WEEKLY/MONTHLY` flags; non-cron triggers are registered as an **enabled** `ONCE` entry at `31.12.2099` (Status `Ready`, never fires by itself) |
| Linux | `crontab` | Task lines with the plugin marker are rewritten via `crontab -` |
| macOS | `launchd` | `StartCalendarInterval` plists |
| POSIX fallback | `crontab` | Used when launchd is unavailable |

File and MCP triggers are not time-based. They are still registered as a far-future
one-shot entry so that `runMatrix`, DAG dependencies and manual runs can start them,
while the OS never fires them on its own. File triggers are additionally watched by
chokidar inside the plugin host.

## Run wrapper

The wrapper is generated per task and is the only place where execution policy is
enforced:

| Concern | Implementation |
| --- | --- |
| Working directory | Task `workingDirectory`, or the workspace path, or the plugin directory |
| Prompt | Written to a prompt file, passed to `opencode run` |
| Timeout | `timeoutSeconds`; on expiry the child process tree is stopped and the run is marked `timeout` (Windows: CIM → WMI → `tasklist`/`Get-Process`, fail-closed tree kill) |
| Workspace env | Variables from the workspace's `.env` file and explicit pairs are injected before `opencode run` (wrapper `env:` / `export`); secret-looking keys are masked in logs; gate suites must reset inherited `AGENT_STEWARD_GATE_ALLOW_PATHS` / `AGENT_STEWARD_CHILD_RUN` to stay deterministic (PL-84) |
| No overlap | Lock file per task; a second start exits immediately and records `skipped` |
| Pre-flight | `beforeScript`; non-zero exit marks `preFlight` as failed |
| Quality Gate | `qualityGate` after a successful run; non-zero exit turns the run into an error |
| Post-flight | `afterScript`; non-zero exit is reported but does not rewrite a success |
| Logging | Append-only log per task under `logs/` |
| History | Calls the recorder with `--start` and `--finish` |

**Prompt encoding (PL-139).** The prompt file is written in UTF-8 (with a BOM on Windows, where PowerShell 5.1 needs it to decode Cyrillic correctly) and read by the wrapper via `Get-Content -Raw -Encoding UTF8` (`core/ps-wrapper.ts`). Mojibake observed when printing the prompt to a PowerShell console or through `Win32_Process.CommandLine` can be an artifact of the terminal's code page and does not mean the file is corrupted — verify by reading it back as UTF-8.

**Gate input and worktree snapshots.** A task with `qualityGate` stores a hash of
the gate command, prompt and timeout when it is created (`core/gate-integrity.ts`,
`gate-snapshots/*.json`); before the gate runs, both wrappers verify that hash and
fail closed on a mismatch (G-1.2). **PL-25:** a parallel agent can edit `src/`
without committing while a task is running, which used to make the start lint green
and the post-flight gate fail on somebody else's uncommitted code. The wrappers now
also capture a worktree snapshot at task start — `HEAD` plus
`git status --porcelain --untracked-files=no -- src` — into a sibling
`*.worktree.json` file, and verify it immediately before the gate. Guard paths are
configurable via `AGENT_STEWARD_GATE_GUARD_PATHS` (separator `|` or `;`). If `HEAD`
or the guarded working tree changed during the run, the gate is skipped and the run
is marked as an error with an explicit message; non-git directories are not guarded.
This prevents a green gate from certifying code that was changed by another task.

**Единый формат lock-токена (B6).** Node (`src/core/lock.ts`), PowerShell
(`src/core/ps-wrapper.ts`) и bash (`src/core/wrappers/bash.ts`) используют один
формат записи владельца: `<pid>-<iso>` (Node добавляет `-<uuid>` для
уникальности токена). Все три стороны понимают и старые варианты:
`<iso>|<pid>` (legacy PowerShell), `<pid>-<epoch>-<uuid>` (legacy Node) и
голый `<pid>` из pid-файла bash. Общий парсер — `parseLockToken()` в Node,
`Get-LockOwnerPid` в PS и `parse_lock_pid` в bash — разбирает legacy
`<iso>|<pid>` до проверки `<pid>-…`: раньше год из ISO принимался за PID,
из-за чего живой lock вытеснялся. Перед своим каталогом `<lock>.d` bash
проверяет файловый lock Node/PS и не запускает задачу, если его владелец жив.
`test-lock-format.mjs` проверяет парсеры и interop в обе стороны.

**Вытеснение каталога `.lock.d` (B7).** При старте плагина `LockManager.initialize()`
читает владельца из `<task>.lock.d/pid` тем же парсером, что и `.lock`, и не
трогает каталог, пока процесс жив, — даже если он старше 24 ч (задача с
`timeoutSeconds: 0` может работать легально долго). Возраст остаётся только
fallback'ом: каталог без pid-файла или с мёртвым PID вытесняется атомарным
`rename` в `.stale-*`. Тест — `test-stale-lock.mjs` (живой PID сохраняется,
мёртвый и безымянный вытесняются).

Windows uses PowerShell and `.cmd` shims; POSIX uses bash. Both wrappers are generated
from templates so the policy stays identical across platforms.

## History, metrics and recovery

`history` stores one row per run: status (`running`, `success`, `error`, `timeout`,
`partial`), start/finish timestamps, duration, error text, tokens, cost, model,
pre/post-flight results, the chained next task, workspace and tool restrictions.
`metrics` holds per-task counters and totals.

Usage (tokens/cost) resolves in both recorder modes: explicit wrapper arguments win,
and when they are `-` the recorder parses the log tail (`parseUsageFromLog`) using the
log path passed as the last argument. This applies to `--finish` (12th argument) and to
the legacy pre-`--start` mode (11th argument, B10); a missing/unreadable log degrades to
the next source instead of failing the record. Many OpenCode providers (for example
hy4-flash-free and local Ollama) print no usage lines at all, so `parseUsageFromLog`
alone leaves tokens at zero. In that case `core/opencode-usage.ts` reads OpenCode's own
SQLite database read-only (`~/.local/share/opencode/opencode.db`, override via
`OPENCODE_USAGE_DB`) and sums assistant-message `tokens`/`cost` from `message.data`
inside a ±2 s window around the run, optionally restricted to the task's working
directory. `record-history.ts` fills only fields that are still missing and emits a
`usage.from_opencode_db` structured event; a missing or locked database is ignored.
Offline tool-surface measurement lives in `core/usage-surface.ts`: it accepts an
injected tokenizer (the test uses `gpt-tokenizer`) so the reported size of the 32-tool
registry is a real token count, not a character heuristic. When none of the sources
above reports usage, `resolveUsageWithOfflineFallback` runs
`estimateRunUsage` (prompt + log tail, ~4 characters per token) and records the
result with a `usage.offline_estimate` event; real values are never overwritten.

If the host or the machine dies mid-run, the row stays in `running`. On the next
plugin activation, `db/recovery.ts` marks stale `running` rows as `error`, so the UI
never shows a permanently running task.

History is bounded by retention: `settings.json` carries `history.retentionDays` and
`history.maxRecords` (defaults 30 / 5000, `0` disables). Cleanup runs at most once a
day on plugin start (`core/retention.ts`), prunes only finished rows via
`pruneHistory` in `db/history-repo.ts`, then `PRAGMA incremental_vacuum` frees space.
Aggregates in `metrics` are never pruned. Period analytics (per-day buckets, success
rate, tokens, cost, matrix/model breakdowns) are computed by `core/analytics.ts` and
exposed as `get_analytics` / `GET /api/analytics`; the dashboard renders a 14-day
block and `GET /api/history/export` serves CSV/JSON.

## Cost controls and tool surface

The 3.10/3.11 work reduced the agent's token bill without changing the execution
semantics:

- **Tool profiles** (`src/core/tool-profile.ts`): `core` exposes 11 tools
  (`schedule_task`, `update_task`, `list_tasks`, `delete_task`, `run_task_now`,
  `get_history`, `get_task_logs`, `dry_run`, `get_dashboard_info`, `backup_db`, `emit_event`),
  `admin` adds 9 advanced/manage tools and `all` exposes all 34.
  `AGENT_STEWARD_TOOL_PROFILE` selects the profile and
  `filterToolSpecsByProfile` applies it at registration time. The 17 "thick" schema
  keys (`matrix`, `guards`, `dependsOn`, `retry*`, `nextTaskOn*`,
  `watch*`, `git*`, `activeDays`, `windowPolicy`, `runWhenLoggedOff`,
  `sessionMaxRuns`, `workspaceId`) are declared only on `schedule_advanced` /
  `update_advanced`, saving about 4.5k tokens per core-profile request.
  - **QA-PORT-4 / PL-129 — event-driven tasks in the core profile**: `mcpEvent`
    is a short field of `coreScheduleTaskSchema`, so `schedule_task` in the core
    profile can create `triggerType: "mcp-event"` tasks, and `emit_event` is a
    core tool that fires their subscribers. The remaining advanced fields
    (`nextTaskOnSuccess` chains, matrix/DAG/retry/window policies) still live on
    `schedule_advanced` / `update_advanced` in the `admin` profile (or require
    `AGENT_STEWARD_TOOL_PROFILE=all`). `tool.error.mcpEventRequired` now only
    means that the event name itself was omitted.
- **Compact history**: `get_history` with `compact: true` truncates `error` to 300
  characters with an explicit `…[truncated]` marker. The SQLite row is untouched;
  `get_task_logs` still returns the full error and log.
- **Usage fallback**: log parsing → read-only OpenCode DB lookup → deterministic
  `estimateRunUsage` (prompt + log tail, ~4 characters per token). The offline
  estimate is recorded as `usage.offline_estimate` only when no other source
  provided tokens and cost; existing values are never overwritten.
- **Token-efficiency KPI**: `tokenEfficiencyScore` in `src/core/budget.ts` computes
  a 14-day score `(totalTokens − wastedTokens) / totalTokens × 100`, where `wasted`
  are `error`/`aborted` runs, plus `scoreByModel`. It is exposed by `get_metrics`
  (MCP and RPC) and shown in the dashboard.
- **Preflight and budgets**: `dry_run` simulates a pipeline (topological order,
  commands, cwd, roles, estimates from recent runs), reports
  `preflightSkipRiskWarnings` and `recommendModelForTask` and executes nothing;
  `preflightScope` validates SCOPE paths before `schedule_task`. `checkBudgetGate`
  blocks over-limit daily/weekly spend and per-task `tokenBudget` at manual/tool/RPC
  entry points and on the OS-scheduler wrapper path since B-1.1 (PL-125).

Per-run `tokenBudget` is implemented (`evaluateTaskTokenBudgetGate`), but cost
forecasting, Grafana export and automatic enforcement of the efficiency score
remain design items; the ledger schema (`SCHEMA_VERSION=14`)
stores `tokens`/`cost` in `history`, not economic columns in `gate_outcomes`.

## Chains, retries and DAG

All three are evaluated by the recorder after a run finishes:

- **Retries** — `retryCount`/`retryDelay` with a retry-state file so a crash cannot
  loop forever. Retries are attempted before chains and dependents.
- **Chains** — `nextTaskOnSuccess` / `nextTaskOnError` start exactly one follow-up task.
- **DAG** — `dependsOn` is satisfied only when every dependency's latest run is
  successful. For a matrix dependency, all clones must be successful; the parent's own
  aggregate record is not enough.

`selectDependentsToTrigger(taskName, definitions, history)` is a pure function, which
keeps the rules testable.

**Dependency completion is an event, not a one-shot latch (PL-40).** Every time a
dependency finishes, its completion is evaluated against the dependencies' latest
records. If all dependencies are currently successful, the dependent is started — even
when an earlier run of the same generation already started it. With two parents this
means the dependent may run once per parent completion (e.g. `T5` with
`dependsOn: [T3, T4]` runs when `T3` finishes while `T4` is still successful, and again
when `T4` finishes). This also applies to a stale but successful record: an older
success still satisfies the gate. The dependent's own latest `startedAt` only suppresses
a re-trigger when it is newer than the newest dependency `finishedAt`. Do not dedupe
across generations — `test-dag-latest-history.mjs` locks this in. For a strict single
run per trigger use `nextTaskOnSuccess` instead of a multi-parent `dependsOn`.

## Matrix builds

A matrix task is a template, not a runnable job:

1. `expandMatrixTask(parent)` produces one clone per workspace:
   `<parent>-matrix-<workspace>`, each with its own `workspaceId`, `matrixParentId`,
   a file trigger and per-workspace overrides applied.
2. `runMatrix(parent)` starts clones according to `strategy` (`parallel`/`sequential`)
   and `concurrency`; extra clones wait in `matrixQueue` persisted on the parent.
3. On each clone completion, the recorder calls `advanceMatrixAfterClone` (drain the
   queue or start the next sequential clone) and `finalizeMatrixIfComplete`.
4. `aggregateMatrixResults(parent)` derives `success` / `error` / `partial` / `running` /
   `empty` from clone history.
5. `syncMatrixFamily(parent)` diffs existing clones against a fresh expansion on update:
   missing clones are created, changed clones are updated, extra clones are removed.
   Clones whose latest run is `running` are never touched.

The parent is registered in the OS scheduler as a far-future one-shot entry only so it
can be addressed by name; it never fires on its own.

## Workspaces

A workspace is a named directory (usually a git repository) with an id, path, optional
remote and color. Workspaces provide:

- the working directory for a task (`workspaceId` instead of `workingDirectory`);
- matrix targets (`matrix.workspaceIds`);
- per-workspace overrides (`matrix.overrides`);
- dashboard grouping;
- env variables: explicit `KEY=VALUE` pairs plus an optional `.env` file (loaded first,
  explicit pairs override), injected into task runs via the wrapper; secret-looking
  keys are masked in logs.

Paths are validated on creation, update and import: a workspace must point to an
existing directory. Env keys must match `^[A-Za-z_][A-Za-z0-9_]*$`; max 100 pairs.

## Triggers

| Trigger | How it fires |
| --- | --- |
| `cron` | OS scheduler on the translated schedule |
| `file` | chokidar watches `watchPath`; debounced change starts the task |
| `git` | Polls `HEAD` in the task working directory; runs when new commits match branch/path/ignore filters |
| `mcp-event` | `emit_event` RPC/tool matches server + event and starts subscribers |

Cron expressions are standard 5-field. The Windows backend supports the subset that
`schtasks` can express; unsupported shapes are rejected at creation time with a clear
error instead of silently drifting.

## Storage

Everything lives under the plugin directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\opencode\agent-steward` (legacy `windows-scheduler` переносится автоматически) |
| macOS/Linux | `$XDG_CONFIG_HOME/opencode/agent-steward` (default `~/.config/...`) |

```
scheduler.db      SQLite database (WAL; схема версионируется через PRAGMA user_version)
logs/             per-task run logs
locks/            lock files
wrappers/         generated .cmd / .sh wrappers
prompts/          prompt files
env/              per-workspace env files (<task>.env), mode 0600 on POSIX
```

Named profiles (Sprint 21) each own a copy of this tree under
`<base>/profiles/<name>` (`default` uses the base directory). Profile directory,
database, settings, logs, wrappers and locks all resolve per-profile.

Override the database location with `OPENCODE_SCHEDULER_DB` (used by tests). Override
the whole plugin directory (database, logs, locks, wrappers, prompts) with
`OPENCODE_SCHEDULER_HOME` on any platform. Profile selection uses
`OPENCODE_SCHEDULER_PROFILE` > `active-profile` marker > `default`.

Schema evolution is additive: `applySchema` runs `CREATE TABLE IF NOT EXISTS` on every
connection and adds missing columns after `PRAGMA table_info`, so upgrading the plugin
never requires a manual migration. `SCHEMA_VERSION` (currently `14`) is stored in
`PRAGMA user_version`; incremental steps live in `MIGRATIONS`.

### Durable run state (Sprint 36.1)

Sprint 36.1 adds `runs` and `run_steps`, the persistence layer for resumable DAG
execution:

| Table | Purpose |
| --- | --- |
| `runs` | One row per execution (`pending → running → passed/failed/cancelled`), with `task_name`, `parent_run_id`, `workspace_id`, `started_at`, `finished_at`, `metadata_json` |
| `run_steps` | One row per step (`pending → running → passed/failed/skipped`), with `position`, `attempt`, `idempotency_key`, `started_at`, `finished_at`, `error`, `output_json`; unique per `(run_id, step_name)`, cascade-deleted with the run |

`src/db/runs-repo.ts` owns the transitions and rejects invalid ones
(`InvalidTransitionError`). A failed step can be retried explicitly (`retryStep`),
which increments `attempt` and returns it to `running`. The tables survive process
crashes and reconnects, which is the prerequisite for resume (36.2),
idempotent steps (36.3) and the dead letter queue (36.4).

`src/db/run-journal.ts` (Sprint 36.1.b) writes every transition to disk before
and after executing the step body: `beginStepAttempt` commits `running` + `started_at`
before the body runs; `recordStepSuccess`/`recordStepFailure` commit `passed`/`failed`
(and `finished_at`/`error`/`output_json`) after it. The high-level wrappers
`runStepStatefully` / `runStepStatefullyAsync` execute `body` between those two
commits and propagate its error while still recording `failed`. `recoverInterruptedSteps`
marks any `running` steps left after a process crash as `failed` — preserving
`attempt`, so the next repeat gets `attempt + 1` and never restarts from 1.
SQLite runs in WAL mode with `synchronous = NORMAL`, so a committed transition
survives a `kill -9` (only the last in-flight commit can be lost with a power cut).

### Step leases (B12)

Schema v9 adds ownership to `run_steps`: `owner_id` (`hostname:pid:startedAt` of
the executing process) and `lease_until`. `beginStepAttempt` writes both when it
commits `running`, with the lease `STEP_LEASE_MS` (60 s) ahead.
`runStepStatefullyAsync` renews the lease from an `unref`'d timer every third of
the lease; synchronous chains call `renewStepLease(runId, stepName)` before long
work. `recoverInterruptedSteps` finalizes only `running` steps whose lease is
missing (legacy rows) or already expired — a live lease belongs to another
process and is left running. Consequently `resumeRunSync` / `resumeRun` refuse to
continue while a live lease remains; `recoverNow` lets a caller treat a lease as
expired (tests and delayed recovery). This prevents a restarted plugin from
marking a live worker's step as failed and from running the same step twice.

### Resume from the middle (Sprint 36.2)

`src/db/run-resume.ts` continues a run after a crash. `run_steps.position`
(schema v3) fixes the order of a linear chain — `created_at` can be identical
for steps inserted in one transaction, so it cannot be used for ordering; on an
existing v2 database the migration backfills `position` from the insertion order.
The `(run_id, position)` index is created after migrations, not in `SCHEMA_SQL`:
on an old database the column does not exist yet, so an early `CREATE INDEX`
would fail before the `ALTER TABLE` step.
`findResumeStep` returns the first step that is not `passed`/`skipped`.
`resumeRunSync` / `resumeRun` then:

1. recover dangling `running` steps (`recoverInterruptedSteps`), so the crash
   victim is retried with `attempt + 1`;
2. skip already passed/skipped steps without invoking their handlers;
3. validate that every remaining step has a handler **before** any side effect;
4. reopen a `failed` run (`reopenRun`, the only `failed → running` transition);
5. execute the rest through the journal and finalize the run as `passed` or
   `failed`.

The result reports `resumedFrom`, `resumedFromAttempt`, `executed`, `skipped`,
`failedStep` and `error`. With `stopOnError: false` the chain continues after a
failure, but the run still ends `failed`. This is covered by
`test-run-resume.mjs`, including a real `kill -9` in the middle of a four-step
chain.

The crash path is also exercised nightly by `test-chaos-dag.mjs`: a child process
runs a four-step chain, the parent sends `SIGKILL` right after the next step has
committed `running`, and the test then verifies the durable state (`passed` steps
are untouched, the victim is `running` with `attempt = 1`, later steps are
`pending`), `PRAGMA integrity_check = ok`, recovery to `failed` with
`attempt = 1`, and a resume that retries the victim with `attempt = 2` and never
re-invokes handlers of completed steps. `.github/workflows/nightly.yml` runs it
on a schedule on Windows and Ubuntu; locally it is `npm run test:chaos`.

### Idempotent steps (Sprint 36.3)

`run_steps.idempotency_key` is unique per run: schema v4 deduplicates legacy
duplicates (keeping the first row, nulling the rest) and replaces the old
non-unique index with the partial unique index `idx_run_steps_key_unique
(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. The index is
created in the migration, after the dedupe — the same ordering trap as
`position`.

`src/db/step-idempotency.ts` exposes `runStepOnce` / `runStepOnceAsync`:

1. a key that belongs to another step in the same run is rejected with
   `IdempotencyConflictError`;
2. an already `passed`/`skipped` step is **replayed** from `output_json` — the
   body is not called, `attempt` does not grow and no side effect repeats
   (`replayed: true`, `executed: false`);
3. a `failed` step is retried with `attempt + 1`, so a transient error does not
   turn into a permanent skip;
4. a `running` step, or a second call for the same key while the first is still
   inside the body, raises `StepInFlightError` — the in-process `inFlight` set
   covers parallel async calls, the unique index covers the database;
5. a missing step is created with the key, then executed through the journal
   from 36.1.b.

The same key is allowed in different runs; `test-step-idempotency.mjs` covers
first execution, replay from cache (including after reconnect), conflicts,
retry and parallel deduplication.

### Dead letter queue (Sprint 36.4)

A step that fails on every attempt is not transient: resuming the run again just
burns another attempt and hides the real problem. Schema v5 adds `run_dlq`, the
durable queue of deterministically failed steps:

| Column | Purpose |
| --- | --- |
| `run_id`, `step_name` | Which step dead-lettered; cascade-deleted with the run |
| `status` | `open → retried` or `open → discarded` |
| `reason` | `attempts-exhausted` (automatic scan) or `manual` |
| `error`, `attempts` | Snapshot of the failure at the moment of enqueue |
| `resolved_at`, `resolution` | When and how the entry was closed (`manual-retry`, `discarded`) |

`src/db/run-dlq.ts` provides:

1. `scanDeadLetters({ runId?, minAttempts = 3, limit })` selects steps with
   `status = failed` and `attempt >= threshold` and enqueues only new ones. The
   partial unique index `idx_run_dlq_open_unique (run_id, step_name) WHERE
   status = 'open'` makes enqueue idempotent, so a repeated scan does not create
   duplicates.
2. `retryDeadLetter(id)` is the manual retry: it reopens the failed run, calls
   `retryStep` (attempt + 1, step back to `running`) and closes the entry as
   `retried` with `resolution = manual-retry`. Closed entries cannot be retried
   or discarded twice.
3. `discardDeadLetter(id, resolution = "discarded")` closes the entry without
   touching the step — the run stays failed.
4. `listDeadLetters` / `countDeadLetters` filter `open` or `all` for dashboards
   (36.6) and metrics.

`retryDeadLetter` calls `reopenRun` and `retryStep`, which each open their own
transaction. `withTransaction` therefore nests through `SAVEPOINT` when a
transaction is already active, keeping the whole retry atomic instead of failing
with `cannot start a transaction within a transaction`. `test-run-dlq.mjs`
covers the threshold, idempotent scans, manual retry, discard, cascade delete,
reconnect and the v4 → v5 migration.

### Dead letter queue in the GUI (Sprint 36.6)

The side panel exposes the queue through `src/core/dlq-api.ts`, a thin facade
that normalises the filter (`open` by default, plus `all`/`retried`/`discarded`)
and clamps the limit, then calls `listDeadLetters` / `retryDeadLetter` /
`discardDeadLetter`. RPC methods `list_dlq`, `retry_dlq` and `discard_dlq` are
declared in `src/rpc.ts` and handled in `src/index.ts`; the two mutations are
audited as `dlq.retry` and `dlq.discard`. `retry_dlq` only prepares the step
(reopen + `attempt + 1` + entry closed) — the handler itself is executed by a
later resume, so the panel never claims a step has already run. The UI section
shows the open count, status filter, creation time, run/step, reason, attempts,
error and status-aware actions; retry and discard ask for confirmation and
refresh the list through the same facade. `test-dlq-gui.mjs` checks the RPC/GUI
wiring, locale parity and the facade behaviour on a temporary SQLite database.

### Pause with context injection (Sprint 36.7)

The durable run model gains a new table `run_injections` (`SCHEMA_VERSION = 7`, migration step 7)
with columns `id`, `run_id` (cascade delete from `runs`), `step_name`, `kind` (`comment` /
`file` / `artifact`), `content`, `author`, `metadata_json`, `created_at`, `consumed_at`,
`consumed_by_step`, `consumed_attempt`, plus indexes `idx_run_injections_run(run_id, created_at)`
and a partial index `idx_run_injections_pending(run_id, step_name) WHERE consumed_at IS NULL`.

A run can be paused between steps: `RunStatus` gains `paused` with transitions
`pending → running/paused/cancelled`, `running → paused/passed/failed/cancelled`,
`paused → running/passed/cancelled`. `pauseRunRecord(id)` sets `paused` without filling
`finished_at`. `pauseRun(runId, input)` in `src/db/run-context.ts` requires an existing,
non-terminal run with no step currently `running`, addresses the first unfinished step (or an
explicit `stepName`), rejects completed/missing targets, and stores one injection per provided
payload (`comment`, `file` with path/content/title, `artifact` with name/content). Secrets are
masked on write: `redactSecretsInText` covers text/comment/file content, and a recursive
`redactValue` with `SENSITIVE_KEY_RE` masks whole values of sensitive JSON keys
(`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*CREDENTIAL*`, `*AUTH*`, ...) to `***`.
A single injection is capped at `MAX_INJECTION_CONTENT` (100 kB).

`listRunInjections(runId, { pendingOnly })` returns history ordered by creation time, exposing
author, masked content and consumption state. `pendingInjectionsForStep(runId, stepName)` returns
the not-yet-consumed injections addressed to a step.

`StepHandler` now receives `(step, context: StepContext)` where `StepContext.injections` holds
the injections for that step. `resumeRunSync` / `resumeRun` pass them before executing each step,
and after a successful step call `consumeInjections(ids, stepName, attempt)` to mark the
injections consumed exactly once (retry keeps them for the next attempt). `finalize` calls
`consumeOrphanInjections` so injections addressed to already-completed steps do not look pending
in the history, and supports `paused → passed` when no steps remain. `ResumeResult` gains
`injected: string[]`. `test-run-context.mjs` covers schema v7, pause-before-start / pause-between
steps / explicit targeting, comment + file + artifact with secret masking and author visibility,
single-consumption on resume, repeated resume without re-delivery, pause without context,
validation errors (missing/completed/running target, terminal run, no unfinished steps, empty
path, artifact without content, oversized content), async resume and cascade delete on run
removal.

### Pause and resume in the GUI (Sprint 36.8)

`src/core/run-panel-api.ts` is the GUI-facing facade over durable runs. `listRunPanel({ filter, limit })`
accepts `active` (pending/running/paused/failed), `all`, or a concrete run status, normalizes the
limit to 1..100 and returns compact `RunPanelRun` entries: status, progress (`doneSteps` /
`totalSteps`), first unfinished `currentStep` with a stable `anchor`, up to 20 context injections
(content preview capped at 500 characters, author, timestamps, consumer) and the count of pending
injections. `active` is also reported for the panel badge.

`pauseRunPanel(runId, { comment, author, stepName? })` delegates to `pauseRun`, returning
`{ success: false, error }` instead of throwing, so the GUI can show the database error next to the
button. `resumeRunPanel(runId)` only prepares the run: it accepts `paused` or `failed`, calls
`reopenRun` (status becomes `running`), and returns the next unfinished step from `findResumeStep`.
Actual step execution remains with `resumeRun` / the DAG executor; the facade never pretends that a
step ran.

RPC methods `list_durable_runs`, `pause_durable_run` and `resume_durable_run` are declared in
`src/rpc.ts`, implemented in `src/index.ts`, and audited as `run.pause` / `run.resume` (target is the
run id). The GUI section «⏯️ Запуски DAG» in `src/gui.tsx` renders the run list with status filter,
progress, current-step anchor link, a comment field, pause/resume buttons with confirmation, a
blocked pause plus warning while the current step is `running`, and the context history with author
and consumer. Locales ru/en/zh stay in sync. `test-pause-gui.mjs` verifies the RPC contract, locale
parity, current-step/progress output, pause with masked comment and author, active/paused filters,
resume preparation, rejection of a repeated resume, end-to-end comment delivery through
`resumeRun`, running-step rejection, failed-run resume and list limits.

## Interfaces

| Interface | Audience | Entry point |
| --- | --- | --- |
| Agent tools | AI agent | 34 tools registered via `ctx.tool.transform` |
| Agent skill | AI agent | `skills/scheduled-job-best-practices` |
| RPC | Sidebar GUI | `src/rpc.ts` contracts, 61 methods |
| Sidebar GUI | Human | `gui-experimental.cjs` |
| Web dashboard | Human | `startDashboardServer` (localhost, random/fixed port) |

## Localization

User-visible text lives in flat JSON catalogs: `locales/en.json` (fallback and default),
`locales/ru.json`, `locales/zh.json` and `locales/tr.json` (A-5.1). All four catalogs
carry the same 916 keys. Keys are dot-separated and grouped by surface —
`gui.*`, `notify.*`, `tool.*`, `dryRun.*`, `matrix.*`, `schedule.*` — and all catalogs
must have the same key set with non-empty values.

`src/i18n.ts` loads the catalogs once and caches them. It exposes `t(key, params)`,
`setLocale(locale)`, `messageIn(locale, key)` and `hasKey(key, locale)`. Lookup order is
active locale → `en` (the default catalog) → the key itself, so a missing translation never renders as
an empty string. The `locale` setting (`auto` default, follows the OpenCode interface
language; `ru`/`en`/`zh`/`tr` are explicit choices) is applied immediately, without restarting
OpenCode. With `auto` and no locale reported by the GUI, English is used.
`auto` is resolved in the GUI through `ctx.locale.locale()` with BCP 47 prefix mapping
(`zh-CN` → `zh`, `en-GB` → `en`); the resolved value is sent to the server as `uiLocale`,
because the server process cannot see the window. The sidebar GUI embeds the catalogs at
build time via `registerCatalog`, because a webview bundle cannot read package files at
runtime.

The template subset is deliberately small and dependency-free:

- `{name}` — interpolation; the caller formats the value (duration, money, date).
- `{count, plural, one {…} few {…} many {…} other {…}}` — plural forms through
  `Intl.PluralRules` for the active locale (`ru` uses one/few/many, `en` and `tr`
  one/other, `zh` only `other`).

Rules:

- a user-visible message is a whole phrase in the catalog, including punctuation; never
  concatenate translated fragments;
- store stable codes, not localized text, in the database; translate at render time;
- agent tool descriptions, schemas and API payloads stay English; `console.*`
  diagnostics follow the active locale, which defaults to English;
- add every new key to all catalogs. `test-docs.mjs` enforces parity and non-empty
  values; `npm run test:en`, `npm run test:zh` and `npm run test:tr` replay all suites
  under `en`/`zh`/`tr` and CI runs them. `OPENCODE_SCHEDULER_LOCALE` only overrides the initial locale for tests
  and services — it is not a user-facing setting.

## Security model

- The dashboard has **no authentication** and binds to localhost. Do not expose it.
- **Dashboard source trust (QW-13).** Every `/api/*` request (except HMAC-authenticated
  `/api/hooks/*`) must come from the dashboard itself: a browser `Origin` is accepted
  only when its host is a loopback name **and** its port equals the port the dashboard
  is actually listening on (or one of the plugin's standard ports before the server
  starts). A page served by an unrelated local dev server (e.g. `http://localhost:3000`)
  can no longer read `/api/export-db`, history or settings or trigger `/api/run`.
  Requests without `Origin` (curl, in-process fetch) are checked by a loopback `Host`
  instead, which also blocks DNS-rebinding. `X-Scheduler-Client` is supplementary only:
  a foreign Origin is never rescued by that spoofable header. `test-dashboard-trust.mjs`
  covers both the pure predicate and live 200/403 responses.
- **Dashboard XSS hardening (B3):** every dynamic value passes through `esc()` before
  reaching text or attribute context; it escapes `&`, `<`, `>`, `"` and `'` (the old
  `div.innerHTML` trick left quotes intact). `GET /` also sends
  `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src
  'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; object-src 'none'`. Both inline scripts
  carry a per-response nonce (16 random bytes, base64). `test-dashboard-xss.mjs`
  extracts the shipped `esc()` from the served page and checks quote/angle-bracket
  payloads in text, `title=` and `data-*=` contexts, plus nonce/CSP consistency.
- A job definition is **code**: prompts, hooks, Quality Gates and wrappers all execute
  with your user privileges. Treat task creation like granting shell access.
- `allowedTools` / `deniedTools` are **enforced at the run-wrapper level** (Sprint 29.2).
  Before each `opencode run`, the wrapper passes `permissions` rules through
  `OPENCODE_CONFIG_CONTENT`: `deniedTools` are mapped to `effect: "deny"` for the
  corresponding OpenCode action (`shell`, `edit`, `glob`, `grep`, `webfetch`,
  `websearch`, `question`, `subagent`, `skill`), and `allowedTools` (if specified)
  additionally denies every action not in the list. No config file is written, so a
  project-level `opencode.jsonc` is preserved and parallel tasks in one workdir do not
  race. The wrapper passes `--auto` so non-denied permissions are auto-approved.
  `allowedTools`/`deniedTools` metadata is still recorded in history for audit.
- **Default policy (`src/core/permissions.ts`):** the baseline is
  `permissions.defaultPolicy` — `hybrid` (default) denies `shell` and `question` while
  allowing read/edit/glob/grep/subagent/skill/webfetch/websearch, `secure` allows only
  read/glob/grep/skill, `legacy` allows everything (1.5.x behaviour). Task `legacyShell`
  re-enables `shell` under `hybrid`; `deniedTools` still wins. Policy denials are
  audited as `tool.blocked` with `reason: "default-policy"`, and each wrapper logs
  `policy=<name>, denied=<actions>` before the run.
- **Audit of blocked tools (Sprint 29.4):** when a task definition is saved,
  `recordTaskToolBlocks()` writes one `tool.blocked` audit event per entry in
  `deniedTools` (`target` = task name, `details.tool` = tool, plus `allowedTools`,
  `deniedTools` and `reason`). In allow-list mode one event with `tool: "*"` records
  that every unlisted tool is denied. The event is emitted on create and on update, so
  changing the task policy also changes the audited details. Because the wrapper runs
  `opencode` as an external process, the plugin cannot observe individual blocked
  attempts at runtime; the audit reflects the enforced policy, not each refusal.
- Task prompts, hooks and Quality Gate scripts are **plain text** executed with your
  user privileges; only secrets (in `secrets.json`, AES-256-GCM) are encrypted.
  Workspace `env` can reference secrets as `${secret:NAME}`; values are masked in
  logs, history and audit. Treat task creation like granting shell access.
- Secrets are stored encrypted in `<PLUGIN_DIR>/secrets.json` (AES-256-GCM) with a
  32-byte key file `secrets.key` (mode 0600 on POSIX; on Windows an ACL that removes
  inheritance and grants the current user only, applied by `icacls` on create and
  re-applied on read for keys created before 1.5.5). Workspace `env` can reference them
  as `${secret:NAME}`; values are substituted at run time and masked in logs,
  history and audit.
- Workspace paths are validated, but hooks are not sandboxed: only schedule jobs from
  repositories you trust.

### Permission model

The effective policy is resolved in this order (later wins):

1. `permissions.defaultPolicy` — the baseline: `hybrid` (default, no `shell`/`question`),
   `secure` (read-only) or `legacy` (everything allowed, 1.5.x behaviour).
2. Task `legacyShell` — re-enables `shell` under `hybrid` only.
3. Task `allowedTools` — if present, every action not listed is denied; an explicitly
   listed action can override a policy denial.
4. Task `deniedTools` — always denied and takes priority over `allowedTools`.
5. The generated `OPENCODE_CONFIG_CONTENT` — passed in the wrapper environment; no file
   is written and the project config stays untouched.
6. Project `opencode.json(c)` and system config — merged by OpenCode; a closer or
   system-level config can weaken task-scoped denies (see limitations below).
7. `--auto` — auto-approves everything that remains, so no interactive prompts block
   an unattended run.

With a non-empty `allowedTools` allowlist (for example a shell-only task with
`allowedTools: ["shell"]`), the safe read-only actions `read`, `glob`, `grep` and
`skill` are always allowed as well — the child agent can read code and load repository
skills even in a shell-only task; only an explicit `deniedTools` entry can deny them.

Tool mapping used by both wrappers:

| Task tool | OpenCode action |
| --- | --- |
| `bash`, `shell` | `shell` |
| `write`, `edit`, `apply_patch`, `remove` | `edit` |
| `glob`, `grep`, `webfetch`, `websearch` | same name |
| `question`, `subagent`, `skill` | same name |

Hooks, Quality Gates and wrapper scripts are outside this model: they run before or
after the agent with the user's privileges and are not filtered by tool policy.

### Permission enforcement — known limitations (spike 29.1 findings)

- `opencode run` CLI (v2.2.3) supports only `--auto` (auto-approve non-denied
  permissions). There are **no** `--allow-tool` / `--deny-tool` CLI flags, so
  per-task restrictions cannot be passed via arguments. Enforcement is done by
  generating a task-scoped config and passing it through `OPENCODE_CONFIG_CONTENT`.
- OpenCode merges `opencode.json(c)` from the current directory up to the filesystem
  root. A project-level `opencode.jsonc` with permissive rules can override or weaken
  task-scoped denies (last matching rule wins, closer directory wins for merge).
  System config (`/etc/opencode`, `%ProgramData%\opencode`) overrides project config.
- Nested agent calls (subagents) use their **own** permissions, not a subset of the
  parent's. A task that denies `subagent` prevents launching subagents, but a launched
  subagent is not further restricted by the parent task's policy.
- **Plan B**: if the task-scoped config passed via `OPENCODE_CONFIG_CONTENT` proves
  insufficient, enforcement can be moved to wrapper-level tool filtering (intercepting
  `opencode run` invocation and refusing to start when a denied tool would be needed)
  or to a managed system-level `policies` entry that hard-denies specific tools
  globally.

## Extension points

| Goal | Where to start |
| --- | --- |
| New OS backend | Implement `SchedulerBackend` in `src/core/scheduler/`, register it in `index.ts` |
| New trigger type | Add a `triggerType` branch in `schedulerCreateTask` and in the wrapper |
| New agent tool | Add a zod schema + execute function, register in `ctx.tool.transform`, add an RPC contract |
| New dashboard panel | Extend `server.ts` routes and the HTML template |
| New matrix policy | Extend `MatrixConfig` in `task-transfer.ts` and the logic in `core/matrix.ts` |

## Mission runtime и гибридные входы (план 38–40)

> Статус: ad-hoc вход реализован (AB-8); internal-оркестрация и `gate_outcomes` — план 40. Что уже в коде — [CHANGELOG.md](../CHANGELOG.md).

Система гибридная: ядро (**mission runtime**) не знает про планировщик ОС.
Планировщик — адаптер входа, регистрация опциональна.

### Классы входа

| Класс | Вход | Регистрация в ОС | Реализация |
|---|---|---|---|
| Ad-hoc | `run_mission` / CLI `run` / GUI / RPC | нет | есть: `core/mission.ts` (AB-8) |
| Внутренний | chain / DAG / retry / escalation | нет | сейчас через `backend.runTask` + force-маркер; план 40 — напрямую в runtime |
| Registered | cron / once / file / git / mcp-event / webhook | да (cron/once) | есть: `core/scheduler/*`, `file-watcher`, `git-trigger`, `integrations` |

### Объекты

| Объект | Содержимое | Таблица |
|---|---|---|
| Миссия | цель + scope + gate-спека + safety + бюджет | `runs` metadata (AB-8); шаблон `missions` — план 38 |
| Задача | миссия-шаблон + триггер | `tasks` (есть) |
| Запуск | durable-исполнение: шаги, попытки, вердикты | `runs` / `run_steps` (есть, SCHEMA_VERSION 14) |
| Исход гейта | вердикт + provenance + экономика | `gate_outcomes` (план 40) |

### Путь исполнения (целевой)

```
вход → intake (gate + safety → политика + бюджет) → createRun(trigger_kind)
     → planner → [route → context compile → execute → GATE]* → artifact → report
```

Существующий путь планировщика (`wrapper → opencode run → record-history → history`)
сохраняется для обратной совместимости; в 40 он подключается к runtime и создаёт
durable-run, а исходы гейта пишутся в ledger.

### Что переиспользуется

- Durable state: `db/runs-repo`, `run-journal`, `run-resume`, `step-idempotency`, `run-context`.
- Роутинг: `core/router/rules|dispatch|escalation|planner`, `db/capability-repo`.
- Права и секреты: `core/permissions`, `core/secrets` (scoped-инъекция).
- Телеметрия: `core/otel`, `core/prometheus`, `core/structured-log`.
- Пауза с инъекциями: `db/run-context` + `core/run-panel-api` → основа approval-гейта.
- Retrieval для scaffolding: подход bag-of-words из `notification_embeddings`.
