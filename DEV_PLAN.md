# KoshRail — Development Plan

Core banking + UPI-style payment switch, built as TypeScript microservices, each owning its own SQLite database, run with Docker Compose. Every phase ends with a **test gate**; the next phase does not start until the gate is green.

## Progress

| Phase | Status | Gate |
|---|---|---|
| 0 Platform skeleton | Done 2026-11-16 | `gate:0` green |
| 1 Identity + gateway | Done 2026-11-16 | `gate:1` green |
| 2 Accounts | Done 2026-11-16 | `gate:2` green |
| 3 Ledger | Done 2026-11-16 | `gate:3` green |
| 4 Bank adapter + VPA | Done 2026-11-16 | `gate:4` green |
| 5 Switch saga | Done 2026-11-18 | `gate:5.1` … `gate:5.5` green |
| 6 Fraud rules engine | Next | |

### Where the build differs from this plan

- **No Docker yet.** Services run as separate Node processes, started by `scripts/stack.ts` (`npm run dev`). Redpanda is replaced by a local `event-bus` service on SQLite that provides topics, consumer-group offsets, seek/replay, long-polling and dedupe by event id. The outbox relay and consumers talk to it through a `Bus` interface, so a Kafka driver can be added later without touching the services.
- **Express 5 instead of Fastify.** It was already proven on this machine, and zod is still used for every request body.
- **scrypt instead of argon2** for MPIN and staff passwords, which avoids a native build.
- **Money** is integer paise held as a JS `number` and checked as a safe integer (up to about ₹90 trillion). SQLite stores it as `INTEGER`.
- **Phase 5 without Docker.** The chaos suite kills switch-service with an internal crash hook (`SWITCH_CHAOS=true`, `process.exit(137)` at a chosen step boundary), and `scripts/stack.ts` restarts it (`restartOnCrash`), standing in for `docker kill` plus a restart policy. The chaos tests live in `tests/e2e/phase-5.4.test.ts` rather than `tests/chaos/`. Phase 5 is split into gates 5.1–5.5 (see `docs/phase-5`). Switch decisions are recorded in `services/switch-service/DECISIONS.md`.
- **Account status consistency.** Account-service pushes a synchronous refresh to the ledger after a status or limit change, and the event acts as a backup. The ledger also re-reads any account that isn't ACTIVE before rejecting an operation. This came out of a race the Phase 3 gate caught.

---

## 1. Ground rules

| Area | Decision |
|---|---|
| Language | TypeScript (strict), Node 24 |
| Repo | npm workspaces monorepo (`services/*`, `apps/*`, `packages/*`) |
| HTTP | Express 5 + zod (schemas shared via `@kosh/contracts`) |
| Internal sync calls | HTTP/JSON with typed clients from `@kosh/contracts` (gRPC deferred; can swap later) |
| Database | SQLite via better-sqlite3 **12.11.1**, WAL mode, one DB file per service on a named Docker volume |
| Messaging | Local `event-bus` service (SQLite log) now, Redpanda once Docker is used; transactional outbox + inbox dedupe |
| Cache / counters | In-process (LRU + SQLite tables) — no Redis |
| Tracing | OpenTelemetry → Jaeger (compose profile `obs`) |
| Frontend | React 19 + Vite, TanStack Router/Query, Tailwind + shadcn/ui, Recharts |
| Tests | Vitest (unit + integration), Playwright (UI e2e), k6 (load), custom chaos runner |
| Money | Integer paise everywhere (safe-integer `number` in TS, `INTEGER` in SQLite). No floats. |
| Line endings | LF only; no code comments |

### SQLite-specific consistency rules
- Every write transaction uses `BEGIN IMMEDIATE` → serializable per database.
- Each service runs **one writer replica** (SQLite single-writer). Scale reads only.
- Ledger keeps **one DB file per bank** (`ledger-KOSH.db`, `ledger-ALPHA.db`, `ledger-BETA.db`) so banks serialize independently.
- Outbox row is written in the same SQLite transaction as the state change; a relay loop publishes to Redpanda and marks rows sent.
- Consumers record `(consumer, event_id)` in an `inbox` table inside the same transaction as their side-effect → exactly-once effect.
- Postings-sum-to-zero enforced in code **and** by a check run on commit (trigger on `journal_entries` status → `POSTED` validating `SUM(postings.amount) = 0`).

---

## 2. Services

| Service | Port | DB file(s) | Owns |
|---|---|---|---|
| api-gateway | 8080 | — | JWT check, rate limit (in-memory token bucket), routing, BFF aggregation, WebSocket hub |
| identity-service | 7001 | identity.db | users, devices, OTP, MPIN, staff roles, JWKS |
| account-service | 7002 | account.db | banks, customers, accounts, limits, KYC tier |
| ledger-service | 7003 | ledger-<BANK>.db | journal, postings, holds, balances, statements |
| bank-adapter | 7004 | adapter.db | per-bank request log, fault injection, bank files |
| vpa-service | 7005 | vpa.db | VPAs, links, resolve cache |
| switch-service | 7006 | switch.db | transactions, saga steps, timeouts |
| fraud-service | 7007 | fraud.db | rules, versions, velocity windows, decisions, cases |
| notification-service | 7008 | notification.db | templates, deliveries |
| settlement-service | 7009 | settlement.db | cycles, net positions, batches |
| recon-service | 7010 | recon.db | runs, records, exceptions |
| audit-service | 7011 | audit.db | hash-chained event store |
| ops-query-service | 7012 | opsquery.db | read models for consoles |
| psp-app | 5173 | — | customer PWA |
| bank-console | 5174 | — | bank ops UI |
| switch-console | 5175 | — | switch ops UI |

Infra containers: `redpanda`, `redpanda-console` (8081), `jaeger` (16686, profile `obs`).

---

## 3. Repo layout

```
KoshRail/
  docker-compose.yml
  docker-compose.test.yml
  packages/
    money/            bigint paise, formatting, parsing
    contracts/        zod schemas, event schemas, typed HTTP clients
    service-kit/      fastify bootstrap, config, logger, health, errors,
                      sqlite (migrations, tx helper), outbox relay, inbox,
                      kafka producer/consumer, idempotency, otel
    test-kit/         temp sqlite, fake clock, kafka test harness, factories
    ui/               shared React components (design system)
  services/<name>/    src/, migrations/, test/, Dockerfile
  apps/psp-app | bank-console | switch-console
  tests/
    e2e/              black-box tests against the running compose stack
    chaos/            fault scenarios
    load/             k6 scripts
```

---

## 4. How each phase is tested

Every phase has three layers and one gate command.

1. **Unit** — pure logic, in-process, fake clock. `npm test -w <service>`
2. **Integration** — one service + real temp SQLite + Redpanda testcontainer (or in-memory bus double).
3. **E2E** — `docker compose up -d --build`, then `tests/e2e/phase-N.test.ts` hits the gateway / services over HTTP.

Gate command per phase:
```
npm run gate:N
```
which runs: `typecheck` → `lint` → unit+integration for touched services → `docker compose up -d --build --wait` → `vitest run tests/e2e/phase-N` → all earlier phase e2e suites (regression) → `docker compose down`.

A phase is **done** only when `gate:N` is green and the manual checklist below is ticked.

---

## 5. Phases

### Phase 0 — Platform skeleton
**Build**
- Monorepo, tsconfig base, eslint, prettier, `.gitattributes` (LF).
- `@kosh/money`, `@kosh/service-kit`, `@kosh/test-kit`, `@kosh/contracts` (empty registry).
- Multi-stage Dockerfile template (node:24-bookworm-slim, builds better-sqlite3 in-image).
- `docker-compose.yml` with redpanda, redpanda-console, jaeger (profile), and a `hello-service` built from the template.
- Outbox relay + inbox in service-kit.

**Tests**
- Unit: money arithmetic/formatting (overflow, rounding refusal, negative).
- Integration: migration runner idempotent; outbox row → published to Redpanda → consumed once even when delivered twice.
- E2E: `GET /health` and `/ready` on hello-service via compose; event round-trip through Redpanda.

**Manual checklist**: Redpanda console shows topic; Jaeger shows a trace (with `--profile obs`).

---

### Phase 1 — Identity + API gateway
**Build**
- identity-service: register (phone, simulated OTP returned in dev), verify OTP, device binding (device id + public key), login, refresh rotation, logout, MPIN set/verify (argon2, 3-strike lockout 24h), staff users + roles (`BANK_OPS`, `SWITCH_OPS`, `FRAUD_ANALYST`, `ADMIN`), JWKS endpoint (RS256).
- api-gateway: route table, JWT verify via JWKS cache, role guard, per-device token-bucket rate limit, request-id + idempotency-key passthrough.
- Events: `UserRegistered`, `DeviceBound`, `MpinLocked`.

**Tests**
- Unit: token issue/verify, refresh reuse detection revokes family, MPIN lockout timing with fake clock.
- Integration: full OTP → device → login against SQLite.
- E2E: register → login → call protected route through gateway; wrong role → 403; 4th wrong MPIN → locked; rate limit returns 429.

---

### Phase 2 — Accounts
**Build**
- account-service: banks (seed KOSH, ALPHA, BETA with IFSC-like codes), customers (masked dummy phones), accounts (SAVINGS, CURRENT, INTERNAL GL), lifecycle `PENDING → ACTIVE → FROZEN → DORMANT → CLOSED`, KYC tiers with daily/per-txn limits, maker-checker for freeze/unfreeze/limit change.
- Chart of accounts per bank: customer liabilities, `SWITCH_SETTLEMENT`, `SUSPENSE`, `FEES`, `CENTRAL_SETTLEMENT`.
- Events: `AccountOpened`, `AccountStatusChanged`, `LimitChanged`.

**Tests**
- Unit: lifecycle transitions table (all illegal transitions rejected).
- Integration: maker cannot approve own request.
- E2E: staff opens account through gateway; freeze flow requires second approver; event visible on topic.

---

### Phase 3 — Ledger (highest test density)
**Build**
- ledger-service, DB per bank.
- `journal_entries`, `postings`, `holds`, `balances` (ledger + available, versioned).
- APIs: `postEntry`, `placeHold`, `captureHold`, `releaseHold`, `reverseEntry`, `getBalance(asOf?)`, `statement`.
- Hold expiry sweeper.
- Local projection of account status from `account.events` (frozen/closed accounts reject debits).
- Invariant checker endpoint `/admin/invariants`.
- Events: `EntryPosted`, `HoldPlaced`, `HoldCaptured`, `HoldReleased`, `HoldExpired`.

**Tests**
- Unit: entry validation (unbalanced, zero, mixed bank, closed account).
- Property (fast-check): 10,000 random sequences of post/hold/capture/release/reverse → invariants always hold (Σ postings = 0; balance = Σ postings; available = ledger − active holds; available ≥ −overdraft).
- Concurrency: 50 parallel holds on one account with balance for 10 → exactly 10 succeed.
- Idempotency: same key replayed 100× → one entry.
- E2E: post via gateway (admin), statement matches, invariants endpoint returns clean.

---

### Phase 4 — Bank adapter + VPA resolver
**Build**
- bank-adapter: switch-facing API per bank (`/banks/:code/hold|credit|capture|release|reverse|status`), maps to ledger calls, idempotent request log keyed by `(txnId, step)`, fault-injection config (latency, error rate, timeout-after-commit, drop response).
- vpa-service: create `handle@bankhandle`, link account (via account-service check), set default, disable, resolve → `{maskedName, bankCode, accountRef}`, LRU cache invalidated by `vpa.events` / `account.events`.
- Events: `VpaCreated`, `VpaLinked`, `VpaDisabled`.

**Tests**
- Unit: VPA format rules, handle uniqueness, masking.
- Integration: adapter replay of same step returns stored response without re-hitting ledger.
- E2E: create VPA through gateway, resolve it; freeze account → resolve returns `ACCOUNT_INACTIVE`; adapter fault "timeout-after-commit" → status endpoint still reports truth.

---

### Phase 5 — Transaction switch (pay flow, two-phase settlement)
**Build**
- switch-service saga orchestrator.
- States: `INITIATED → RISK_PASSED → DEBIT_HELD → CREDITED → COMPLETED`; failure: `DEBIT_FAILED`, `CREDIT_FAILED → REVERSING → REVERSED`, `DEEMED → COMPLETED|REVERSED`.
- Fraud step stubbed as always-allow (real one in Phase 6).
- Every step persisted to `saga_steps` before and after the call; on restart, a recovery loop resumes non-terminal sagas.
- Per-step timeouts, retries with jitter (idempotent steps only), circuit breaker per bank.
- Status-inquiry poller for `DEEMED`.
- RRN generation, customer-facing `POST /pay`, `GET /txn/:id`.
- Events: `TxnInitiated`, `TxnStepCompleted`, `TxnCompleted`, `TxnFailed`, `TxnDeemed`, `TxnReversed`.

**Tests**
- Unit: state machine transition table; retry policy.
- Integration: happy path with in-process fake adapters; every failure branch.
- **Chaos suite** (`tests/chaos/`): for each step boundary, kill switch-service (`docker kill`) or inject adapter fault, restart, wait → assert every txn terminal and every bank ledger balanced, and Σ money across all banks unchanged.
- E2E: two users at different banks, pay ₹500, both balances correct; insufficient funds → `DEBIT_FAILED` and no hold left; double-click same idempotency key → one txn.

---

### Phase 6 — Fraud rules engine
**Build**
- Rule DSL (JSON): conditions on amount, velocity (count/sum over 1m/1h/24h), new payee, payee VPA age, device age, hour of day, recent declines, distinct payers to payee in 1h; weight; action hint; hard-block flag.
- Compiler → predicates; scoring bands `ALLOW <40 ≤ STEP_UP <70 ≤ REVIEW <90 ≤ BLOCK`.
- Velocity windows in SQLite (bucketed per minute) fed by `switch.txn` events.
- Rule lifecycle: draft → backtest → shadow → published; rollback.
- Review cases with SLA; approve resumes saga, reject/expire cancels hold.
- Switch calls fraud synchronously with 150 ms budget and fallback policy.

**Tests**
- Unit: DSL parser/validator, each operator, scoring bands, hard-block short-circuit.
- Integration: backtest over seeded history gives expected hit counts; shadow rule logs but does not affect decision.
- E2E: 6 rapid payments trip velocity rule → `RISK_REVIEW`; analyst approves → `COMPLETED`; reject → hold released; fraud-service down → fallback policy applied.

---

### Phase 7 — Collect requests + notifications
**Build**
- Collect: payee requests, payer approves with MPIN or declines, expiry (default 30 min), reuses pay saga after approval.
- notification-service: templates, simulated SMS/email log, in-app push via gateway WebSocket.

**Tests**
- Unit: collect expiry, duplicate request suppression.
- E2E: request → payer sees it via WebSocket → approve → both get notifications; expired request cannot be approved.

---

### Phase 8 — Settlement
**Build**
- Business date + cycle cutoffs (4 per day default, configurable), cycle assignment for each completed/reversed txn.
- Net position matrix per cycle (bilateral + multilateral net).
- Settlement postings through each bank's ledger against `CENTRAL_SETTLEMENT`.
- Events: `CycleClosed`, `NetPositionComputed`, `SettlementPosted`.

**Tests**
- Unit: netting math (property test: Σ multilateral nets = 0).
- Integration: txn straddling cutoff lands in next cycle.
- E2E: run 200 random payments, force cutoff, net positions equal per-bank Σ from ledgers; `SWITCH_SETTLEMENT` GLs zero after settlement.

---

### Phase 9 — End-of-day reconciliation
**Build**
- Bank-adapter produces daily bank files (CSV); switch produces its file.
- 3-way matcher on `rrn + amount + status`.
- Mismatch categories: missing at issuer/acquirer/switch, amount mismatch, status mismatch, duplicate, orphan hold, late reversal.
- Auto-resolve: expire orphan holds, settle DEEMED, reverse one-sided credit. Others → exception queue with maker-checker resolution.
- Daily invariant: per bank, Σ customer debits − Σ customer credits = net settlement.

**Tests**
- Unit: matcher against hand-crafted record sets for each category.
- E2E: seed faults through adapter fault-injection (drop response, duplicate credit, orphan hold), run EOD → each fault detected with correct category; auto-fixable ones resolved; ledgers balanced after.

---

### Phase 10 — Audit + ops-query
**Build**
- audit-service consumes all topics, appends to hash chain (`hash = sha256(prev_hash + event)`), verify endpoint, search.
- ops-query-service: txn search, saga trace view, live metrics (throughput, success rate, latency by bank, decline reasons), settlement and recon views.

**Tests**
- Unit: chain verify detects tampered row.
- E2E: after Phase 5–9 e2e flows, audit chain verifies; trace for a txn lists every step in order; dashboard metrics equal counts from switch.db.

---

### Phase 11 — PSP customer app
**Build**: onboarding (phone → OTP → device → bank → account → VPA → MPIN), home + balance (MPIN), pay to VPA / QR scan, live status screen, collect inbox, QR receive, history + detail, disputes, settings (VPAs, MPIN, devices, limits). Served by nginx container.

**Tests**
- Component tests (Vitest + Testing Library): MPIN pad, amount input (paise-safe), status screen states.
- Playwright: full onboarding → pay another user → history shows txn; collect approve flow; locked MPIN UX.

---

### Phase 12 — Bank operations console
**Build**: customer 360, account actions with maker-checker, ledger explorer (entries, postings, holds), GL view, adapter health + fault-injection panel, bank-side recon exceptions. RBAC scoped to staff's bank.

**Tests**
- Component tests for tables/filters.
- Playwright: maker freezes → checker approves → customer pay fails in PSP app; fault-injection toggle produces DEEMED txn visible in ledger explorer.

---

### Phase 13 — Switch operations console
**Build**: live monitor (WebSocket), txn trace timeline, fraud workspace (visual rule builder → DSL, backtest, shadow compare, review queue with SLA timers), settlement (cycle calendar, net-position heatmap), recon workbench, DLQ viewer + replay, bank onboarding, audit search.

**Tests**
- Component tests: rule builder emits valid DSL for each operator.
- Playwright: build + publish rule → PSP payment gets reviewed → approve in queue; run EOD → resolve exception with maker-checker.

---

### Phase 14 — Hardening
**Build**: k6 scripts, full chaos matrix, DLQ replay, runbooks, `npm run gate:all`.

**Tests**
- Load: 100 TPS sustained 10 min on local Docker (SQLite single-writer target), p99 < 800 ms, 0 ledger invariant breaks.
- Chaos: random kill of any service every 30 s during load → after recovery all txns terminal, EOD recon clean.
- Full regression: `gate:0` … `gate:13`.

---

## 6. Milestones

| Milestone | Phases | What you can demo |
|---|---|---|
| M1 Foundations | 0–2 | Login, accounts, events on Redpanda |
| M2 Money moves | 3–5 | Cross-bank payment surviving crashes |
| M3 Risk + ops | 6–10 | Fraud review, settlement, EOD recon, audit |
| M4 Product | 11–13 | Three UIs end to end |
| M5 Production-grade | 14 | Load + chaos report |

---

## 7. Prerequisites

- Docker Desktop **engine running** (Linux containers).
- Node 24, npm (workspaces). pnpm not required.
- Host-side `npm install` may need install scripts approved for better-sqlite3; containers build it themselves.
