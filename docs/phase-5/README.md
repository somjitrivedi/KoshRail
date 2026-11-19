# Phase 5: The Transaction Switch (Student Handbook)

> **Type of work: 100% backend.** Phase 5 has no user interface, screens or HTML. You build one new backend service (`switch-service`), make small changes to four existing backend services, and write automated tests. You check your work with HTTP calls and the test gates. The screens that will use this service come later: Phase 11 (customer app) and Phase 13 (switch operations console).

Read this whole file before you start. Then work through the sub-phases **in order**. Each one builds on the previous one.

| Sub-phase | File | What you build | Depends on |
|---|---|---|---|
| 5.1 | [5.1-payment-intake.md](5.1-payment-intake.md) | The service skeleton and secure acceptance of a payment request. No money moves yet. | Phases 0–4 |
| 5.2 | [5.2-saga-orchestrator.md](5.2-saga-orchestrator.md) | Moving money between banks: hold, credit, capture, plus the business failure paths | 5.1 |
| 5.3 | [5.3-resilience.md](5.3-resilience.md) | Timeouts, retries, circuit breakers, unknown outcomes (DEEMED), status inquiry | 5.2 |
| 5.4 | [5.4-crash-recovery.md](5.4-crash-recovery.md) | Recovery after crashes, leases, fencing tokens, two switch processes at once | 5.3 |
| 5.5 | [5.5-simulation-and-ops.md](5.5-simulation-and-ops.md) | Deterministic simulation testing, load testing, staff resolution tools, metrics | 5.4 |

---

## 1. What KoshRail is, and where you are joining

KoshRail is a simulated **core banking system plus a UPI-style payment switch**. Phases 0–4 already exist and are fully tested. You join at the point where the system can hold money and look up VPAs, but **nothing yet ties them together into a payment**. That missing piece is your job.

```
Customer app (Phase 11, later)
        |
   api-gateway :8080  ---- verifies JWT, rate limits, forwards a "principal"
        |
   switch-service :7006   <== YOU BUILD THIS
     |        |          \
 identity   vpa-service   bank-adapter :7004 ---- ledger-service :7003 (one SQLite DB per bank)
  :7001       :7005                                      |
                                                  account-service :7002
   event-bus :7000 (Kafka-like log: every service publishes events here)
```

### What already exists (do not rebuild these)

| Service | Port | What it gives you |
|---|---|---|
| `event-bus` | 7000 | Topics, consumer groups, offsets, replay. Services publish to it through an outbox. |
| `identity-service` | 7001 | Customer sign-up with OTP, device keys, JWT, MPIN with lockout, MPIN tokens, staff roles |
| `account-service` | 7002 | Banks KOSH, ALPHA and BETA; customers; accounts; KYC limits; maker-checker |
| `ledger-service` | 7003 | Double-entry ledger, **holds** (reserve money), capture, release, reversal, invariant checker |
| `bank-adapter` | 7004 | The switch-facing API of each bank (`hold`, `credit`, `capture`, `release`, `reverse`, `status`), fault injection |
| `vpa-service` | 7005 | VPAs such as `asha@kosh`, linking to accounts, `resolve` |
| `api-gateway` | 8080 | The public entry point. Routes `/api/<service>/...`. |

### The payment you will implement

A payment of ₹500 from `asha@kosh` (account at KOSH bank) to `ravi@alpha` (account at ALPHA bank):

1. **Hold** ₹500 on Asha's account at KOSH. The money is reserved, not yet moved.
2. **Credit** ₹500 to Ravi's account at ALPHA. This debits ALPHA's `SWITCH_SETTLEMENT` GL account.
3. **Capture** the hold at KOSH. Asha's money moves into KOSH's `SWITCH_SETTLEMENT` GL account.
4. The payment is `COMPLETED`.

Settling between the banks (KOSH owes ALPHA ₹500) is Phase 8 and **not** your job. Your job is to make sure steps 1–3 always end in a correct state, even when banks fail, the network lies, or the switch crashes.

---

## 2. Concepts you must understand

Read about each of these before 5.2. Short explanations follow.

| Concept | One-line explanation | Used in |
|---|---|---|
| **Saga** | A long business transaction split into steps. Each step has a compensating "undo" step. There is no global database transaction across services. | 5.2 |
| **Two-phase settlement / TCC** | Try (hold) → Confirm (capture) or Cancel (release). You reserve first and commit later. | 5.2 |
| **Idempotency** | Sending the same request twice has the same effect as sending it once. Every bank call must be safe to retry. | All |
| **Write-ahead step log** | Write down what you are *about to do* before you do it, and what *happened* after. After a crash, read the log to know where you were. | 5.2, 5.4 |
| **Unknown outcome (DEEMED)** | A request timed out: the bank may or may not have done it. You must never guess. You ask (status inquiry) or safely retry. | 5.3 |
| **Circuit breaker** | After many failures to one bank, stop calling it for a while (fail fast), then test it with one probe call. | 5.3 |
| **Bulkhead** | Cap the concurrent calls per bank so one slow bank cannot use up all resources. | 5.3 |
| **Lease + fencing token** | A time-limited lock on a saga, plus a number that increases every time ownership changes, so a "zombie" process with an old number cannot write. | 5.4 |
| **Deterministic simulation testing** | Run the real logic against fake banks and a fake clock, driven by a seeded random generator. A failing seed can be replayed exactly. | 5.5 |

---

## 3. Setting up

Requirements: Node 24, npm, Windows PowerShell or any shell. **Docker is not used.**

```
cd KoshRail
npm install
npm run gate:4        # must print "gate:4 GREEN" before you change anything
npm run dev           # starts every service; gateway on http://127.0.0.1:8080
npm run seed          # (second terminal) demo staff + 3 funded customers with VPAs
```

After `npm run seed` you have:

| Who | Login | Notes |
|---|---|---|
| Admin | `admin` / `Admin@12345` | role ADMIN |
| Bank staff | `maker.kosh`, `checker.kosh`, `maker.alpha`, … / `Kosh-Staff-123` | role BANK_OPS |
| Switch staff | `switch.ops` / `Kosh-Staff-123` | role SWITCH_OPS |
| Customers | `asha@kosh` (KOSH), `ravi@alpha` (ALPHA), `meera@beta` (BETA) | ₹10,000 each, MPIN `1357` |

`npm run reset` deletes all local data. On Windows, run vitest from PowerShell or cmd. Git Bash breaks it.

---

## 4. Rules for this codebase (non-negotiable)

1. **TypeScript strict.** `npm run typecheck` must pass.
2. **No code comments.** Write clear names instead.
3. **LF line endings only** (`.gitattributes` already enforces this).
4. **Money is integer paise.** ₹500 = `50000`. Never use floats for money. Use `@kosh/money` helpers.
5. **Every write is a transaction.** Use `tx(db, () => { ... })` from `@kosh/service-kit`. It runs `BEGIN IMMEDIATE`.
6. **State changes and their events are written together.** Call `emit(db, {...})` inside the same `tx` as the state change (transactional outbox).
7. **Never call another service's database.** Only call its HTTP API.
8. **Validate every request body with zod** through `parse(schema, req.body)`.
9. **Errors** are thrown as `AppError` using the helpers `badRequest`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `tooMany`, `unavailable`. The response shape is always `{ "error": { "code", "message", "details?" } }`.
10. **Tests are part of the work.** A sub-phase without its tests is not done.

### Library you must reuse: `@kosh/service-kit`

| Function | What it does |
|---|---|
| `createApp({ name, internalToken, log }, (app) => {...})` | Express app with JSON parsing, request id, `/health`, `/ready`, internal-token check, error handler |
| `openDb(file, migrationsDir(import.meta.url))` | Opens SQLite (WAL, foreign keys) and runs `migrations/*.sql` in order |
| `tx(db, fn)` | Synchronous `BEGIN IMMEDIATE` transaction. Nested calls become savepoints. |
| `emit(db, { topic, type, key, payload }, clock)` | Writes an event to the outbox. Must be called inside `tx`. |
| `OutboxRelay` | Publishes outbox rows to the event bus. Start it in `main.ts`. |
| `idempotencyKey(req)` / `idempotent(db, scope, key, body, fn)` | Request-level idempotency. Replays return the stored response. |
| `ServiceClient` | Typed HTTP client for other services. It throws `AppError` with the upstream status and code, `504 UPSTREAM_TIMEOUT` on timeout, and `503 UPSTREAM_UNAVAILABLE` when the connection fails. |
| `getCaller`, `requireCustomer`, `requireStaff(req, roles)`, `requireServiceOrStaff` | Read the caller identity that the gateway forwards |
| `Clock`, `systemClock`, `businessDayStartIso`, `sleep`, `newId`, `sha256`, `stableStringify` | Utilities |
| `Loop` | A repeating background job with error logging |

Look at `services/vpa-service` and `services/bank-adapter`. They are the best examples of a complete service.

---

## 5. Existing APIs you will call (reference)

All internal calls need two headers: `x-kosh-internal-token` (env `KOSH_INTERNAL_TOKEN`, dev default `kosh-dev-internal-token`) and `x-kosh-caller: switch-service`. `ServiceClient` adds both for you.

### bank-adapter (`KOSH_ADAPTER_URL`, default `http://127.0.0.1:7004`)

Each `(bank, txnId, step)` is recorded. Sending the **same body again** returns the stored answer with header `idempotent-replayed: true` and never touches the ledger twice. Sending a **different body** for the same `(bank, txnId, step)` returns `409 ADAPTER_REQUEST_MISMATCH`, so retries must send byte-for-byte the same fields.

| Call | Body | Success (200) |
|---|---|---|
| `POST /banks/:bank/hold` | `{ txnId, accountId, amount, ttlSeconds }` | `{ status: "HELD", holdId, accountId, amount, expiresAt, txnId, bankCode, step }` |
| `POST /banks/:bank/credit` | `{ txnId, accountId, amount, description? }` | `{ status: "CREDITED", entryId, accountId, amount, ... }` |
| `POST /banks/:bank/capture` | `{ txnId, holdId }` | `{ status: "CAPTURED", holdId, entryId, accountId, amount, ... }` |
| `POST /banks/:bank/release` | `{ txnId, holdId }` | `{ status: "RELEASED", holdId, holdStatus, ... }` |
| `POST /banks/:bank/reverse` | `{ txnId, entryId, reason }` | `{ status: "REVERSED", entryId, reversedEntryId, ... }` |
| `GET /banks/:bank/status/:txnId` | – | `{ txnId, bankCode, steps: [{ step, status: "IN_PROGRESS"/"DONE"/"FAILED", httpStatus, response }], ledger: { entries: [...], holds: [...] } }` |

How to classify adapter errors (this classification is **fixed**; use it exactly):

| HTTP status | Meaning | Examples | What the switch does |
|---|---|---|---|
| 200 | Done | – | Continue |
| 400, 404, 409, 422 | **Business failure**. Definitive, the step did NOT happen. Retrying will not help. | `INSUFFICIENT_FUNDS`, `ACCOUNT_NOT_ACTIVE`, `ACCOUNT_NOT_OPEN`, `LIMIT_PER_TXN_EXCEEDED`, `LIMIT_DAILY_EXCEEDED`, `HOLD_EXPIRED`, `HOLD_NOT_ACTIVE` | Take the failure branch |
| 502, 503 | **Transient**. The step did NOT happen. Safe to retry. | `BANK_UNAVAILABLE`, `ADAPTER_FAULT_INJECTED`, `UPSTREAM_UNAVAILABLE` | Retry with backoff |
| 504 / client timeout / socket closed | **Unknown**. The step MAY have happened. | `UPSTREAM_TIMEOUT`, dropped connection | Never assume. Retry the identical request (safe: adapter is idempotent) or ask `status`. |

Exception: `409 ADAPTER_REQUEST_MISMATCH` means **your code has a bug**: you changed the body of a retry. Log it at error level and send the saga to `MANUAL_REVIEW`.

Fault injection, which you will use in tests: `PUT /banks/:bank/faults/:op` with `{ mode, latencyMs?, errorRate?, remaining? }`. Modes: `NONE`, `LATENCY`, `ERROR` (503 before doing anything), `TIMEOUT_AFTER_COMMIT` (does the work, then hangs for `ADAPTER_FAULT_HANG_MS`), `DROP_RESPONSE` (does the work, then kills the socket). `DELETE /banks/:bank/faults` clears all faults for that bank.

### vpa-service (`KOSH_VPA_URL`, default `http://127.0.0.1:7005`)

`GET /resolve/:address`, called as a service, returns `{ address, maskedName, bankCode, accountRef, status: "ACTIVE" }`. `accountRef` is the ledger account id. Errors: `404 VPA_NOT_FOUND`, `422 VPA_DISABLED`, `422 VPA_NOT_LINKED`, `422 ACCOUNT_INACTIVE`, `400 VPA_FORMAT`.

### identity-service (`KOSH_IDENTITY_URL`, default `http://127.0.0.1:7001`)

- `POST /mpin/verify`, called by a customer through the gateway at `/api/identity/mpin/verify`, with body `{ mpin, purpose }`, returns `{ mpinToken, expiresAt }`. The token is valid for 120 s.
- `POST /internal/mpin-tokens/verify`, called as a service, with body `{ token }`, returns `{ userId, purpose, jti }`. It returns 401 if the token is invalid or expired.

### ledger-service (read only, for tests)

`GET /admin/invariants`, called as a service or by ADMIN/SWITCH_OPS staff, returns `{ ok, banks: [{ bankCode, ok, checks: [...] }] }`. **Every one of your test suites must end by asserting `ok === true`.**

---

## 6. How gates work for Phase 5

A **gate** is one command that proves a sub-phase is done. In 5.1 you extend `scripts/gate.ts` so it accepts `5.1` … `5.5`. Gate `5.3` must run:

1. `npm run typecheck`
2. `npm run lint`
3. All unit and integration tests of phases 0–4 **and** `services/switch-service`
4. E2E: `tests/e2e/phase-0` … `phase-4` **and** `phase-5.1`, `phase-5.2`, `phase-5.3`

You can only call a sub-phase done when `npm run gate:5.x` prints `GREEN`. Never edit or delete an earlier test to make a gate pass. If an old test fails, your change broke something.

---

## 7. When the spec does not answer your question

These documents are written so you do not need to ask anyone. If you still meet something unspecified:

1. Pick the **simplest option that is consistent with the existing code** (look at how `vpa-service` or `bank-adapter` did it).
2. Write it down in `services/switch-service/DECISIONS.md` as one line: `- <date> <sub-phase>: <question> -> <what you chose> because <reason>`.
3. Carry on. Decisions recorded this way are accepted unless they break a rule in section 4 or a test in the spec.

## 8. Definition of done (every sub-phase)

- [ ] `npm run gate:5.x` prints `GREEN`
- [ ] Every test listed in the sub-phase file exists, with the given name or a clearly matching one
- [ ] Ledger invariants are `ok: true` at the end of every e2e and chaos test
- [ ] `DECISIONS.md` updated for anything you decided yourself
- [ ] Short entry in `services/switch-service/CHANGELOG.md`: what you added and how to try it
- [ ] No code comments, no `any` in `src/` (it is allowed in tests), no floats for money

## 9. Grading guide (for reference)

| Weight | Area |
|---|---|
| 40% | Correctness: money is never created, lost or double-moved, in any test |
| 25% | Tests: coverage of the listed cases, and tests that would catch real bugs |
| 15% | Failure handling: every error path ends in a defined state |
| 10% | Code quality: follows section 4, reuses service-kit, clear names |
| 10% | Documentation: DECISIONS.md and CHANGELOG.md are honest and useful |
