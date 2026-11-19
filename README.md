# KoshRail

Core banking and a UPI-style payment switch built as TypeScript microservices. Every service owns its own SQLite database and talks to the others over HTTP plus an event bus.

Status: phases 0–5 of [DEV_PLAN.md](DEV_PLAN.md) are built and their gates pass. Phase 5 (the payment switch) is described in [docs/phase-5](docs/phase-5/README.md). Fraud, settlement and reconciliation come next.

## Running without Docker

Requirements: Node 24 and npm.

```
npm install
npm run dev        # starts all services, gateway on http://127.0.0.1:8080
npm run seed       # in a second terminal: staff, three demo customers, funded accounts, VPAs
npm run reset      # deletes ./data
```

`npm run dev` sets `OTP_DEV_ECHO=true`, so OTP responses include `devCode`. Never enable that outside development.

## Services

| Service | Port | Database | Role |
|---|---|---|---|
| event-bus | 7000 | event-bus.db | Kafka-style log: topics, offsets, consumer groups, redelivery |
| identity-service | 7001 | identity.db | OTP signup, device binding, RS256 JWT + JWKS, refresh rotation, MPIN, staff RBAC |
| account-service | 7002 | account.db | Banks, chart of accounts, customers, accounts, KYC limits, maker-checker |
| ledger-service | 7003 | ledger-KOSH/ALPHA/BETA.db | Double-entry journal, holds, reversals, statements, invariants |
| bank-adapter | 7004 | adapter.db | Switch-facing bank API, request log, fault injection |
| vpa-service | 7005 | vpa.db | VPA registry, linking, cached resolve |
| switch-service | 7006 | switch.db | `POST /pay`, saga (hold, credit, capture, reversal), retries, circuit breakers, DEEMED status inquiry, crash recovery with leases and fencing, ops tools and metrics |
| api-gateway | 8080 | none | JWT verification, routing, rate limiting, principal propagation |

## Test gates

Each phase has a gate. A gate runs typecheck, lint, the unit and integration tests for every phase up to N, and then the end-to-end suites for phases 0..N against a freshly spawned stack:

```
npm run gate:4
npm run gate:5.3     # Phase 5 has sub-gates 5.1 to 5.5; gate:5 is the same as gate:5.5
```

Phase 5 extras: `npm run sim:switch` runs the deterministic switch simulation (`SIM_SEED=<n>` replays one seed). `npm run load:switch` runs a load test against a running `npm run dev` stack.

Run vitest from PowerShell or cmd. Git Bash breaks it on this machine.

## Consistency model

- Money is integer paise.
- Every write is a `BEGIN IMMEDIATE` transaction.
- Ledger triggers reject unbalanced, edited or deleted postings.
- Events leave through a transactional outbox and are applied through an inbox table, so each event takes effect exactly once.
- Mutating ledger calls require an idempotency key.
- Account status reaches the ledger in two ways: account-service pushes a refresh, and the event acts as a backup. The ledger also re-reads any account that isn't ACTIVE before rejecting it.
