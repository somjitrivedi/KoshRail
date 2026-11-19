# switch-service changelog

## 5.5 - simulation and operations (2026-11-18)

Added
- Deterministic simulation: `test/simulation.test.ts`, 30 seeds in the gate, with random bank faults, latency, hold expiry and process crashes. Invariants are checked per seed. Replay one seed with `SIM_SEED=17 npm run sim:switch`; run more with `SIM_SEEDS=200`.
- Staff tools for `SWITCH_OPS` / `ADMIN`: `GET /ops/txns?state=`, `GET /ops/txns/:id?inquire=true` (steps, transitions, ops actions, live bank status), `POST /ops/txns/:id/retry`, `POST /ops/txns/:id/reverse`. Both POSTs require `{ reason }` and are recorded in `ops_actions`.
- Metrics: `GET /ops/metrics?windowMinutes=15` (counts by state, success rate, completion latency p50/p95/p99, outcomes per bank and step, breaker and bulkhead state, engine counters) and `GET /ops/breakers`.
- Load test: `npm run load:switch` against a running stack (`LOAD_PAYMENTS`, `LOAD_CONCURRENCY`, `LOAD_PAIRS`).

Try it: `npm run dev`, then `npm run load:switch`. Log in as `switch.ops` and call `GET /api/switch/ops/metrics`.

## 5.4 - crash recovery (2026-11-18)

Added
- A lease and fencing token on every transaction. Every step-log write and state change checks the fence, so a stale process cannot write.
- A recovery loop (`SWITCH_RECOVERY_INTERVAL_MS`) that resumes non-terminal sagas whose lease has expired.
- Chaos hook `PUT /internal/chaos { crashAt, txnId? }` when `SWITCH_CHAOS=true`. Crash points are `<step>:before-call`, `<step>:after-call` and `after:<STATE>`.
- `scripts/stack.ts` option `restartOnCrash` (the e2e stack uses it for switch-service).

Try it: run the stack with `SWITCH_CHAOS=true`, call `PUT http://127.0.0.1:7006/internal/chaos {"crashAt":"credit:after-call"}` with the internal-token headers, then make a payment. The process exits and has to be restarted. The payment then completes.

## 5.3 - resilience (2026-11-18)

Added
- Per-step timeout (`SWITCH_STEP_TIMEOUT_MS`), retries with full jitter (`SWITCH_MAX_ATTEMPTS`, `SWITCH_RETRY_BASE_MS`, `SWITCH_RETRY_CAP_MS`), a circuit breaker per bank (`SWITCH_BREAKER_THRESHOLD`, `SWITCH_BREAKER_COOLDOWN_MS`) and a bulkhead (`SWITCH_BULKHEAD_LIMIT`).
- The fixed adapter error classification (`src/classify.ts`). `ServiceClient` now reports the socket error cause so a refused connection can be told apart from a dropped one.
- DEEMED handling through status inquiry (`SWITCH_DEEMED_POLL_MS`, `SWITCH_DEEMED_MAX_POLLS`), and parking with backoff for steps that must finish.

Try it: `PUT /api/adapter/banks/ALPHA/faults/credit {"mode":"LATENCY","latencyMs":5000}` as admin, then pay to an ALPHA VPA. The payment goes DEEMED, then completes through status inquiry.

## 5.2 - saga orchestrator (2026-11-18)

Added
- `SagaEngine`: INITIATED -> RISK_PASSED -> DEBIT_HELD -> CREDITED -> COMPLETED, plus DEBIT_FAILED, CREDIT_FAILED -> REVERSING -> REVERSED, DEEMED and MANUAL_REVIEW. Transitions follow the table in `src/machine.ts`.
- Write-ahead step log `saga_steps`: a row is STARTED before each bank call and finished with OK / BUSINESS / TRANSIENT / UNKNOWN / MISMATCH after it. Transition history is in `txn_transitions`.
- Events on `switch.txn`: TxnInitiated, TxnStepCompleted, TxnCompleted, TxnFailed, TxnDeemed, TxnReversed, TxnManualReview. All of them go through the outbox.

Try it: `npm run seed`. Log in as Asha, verify MPIN `1357` with purpose `PAYMENT`, then `POST /api/switch/pay` to `ravi@alpha`.

## 5.1 - payment intake (2026-11-18)

Added
- New service `switch-service` on port 7006 with database `switch.db`, routed by the gateway at `/api/switch`.
- `POST /pay` (customer, `Idempotency-Key` required): body `{ payerVpa, payeeVpa, amount, note?, mpinToken }`. It validates the body, verifies the MPIN token with identity (the token must belong to the caller, have purpose PAYMENT and be unused), checks that the payer owns the payer VPA, resolves the payee, and assigns an RRN. Returns 202.
- `GET /txn/:id` (payer, payee or SWITCH_OPS) and `GET /txns` (the customer's own).
- vpa-service returns `userId` to service callers. gate.ts accepts `5.1`-`5.5` (and `5` = `5.5`).
