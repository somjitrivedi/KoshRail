import { envInt } from '@kosh/service-kit';

export interface SwitchConfig {
  holdTtlSeconds: number;
  maxTxnAmount: number;
  stepTimeoutMs: number;
  inquiryTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
  parkBaseMs: number;
  parkCapMs: number;
  breakerFailureThreshold: number;
  breakerCooldownMs: number;
  bulkheadLimit: number;
  leaseMs: number;
  recoveryIntervalMs: number;
  recoveryBatch: number;
  deemedPollMs: number;
  deemedMaxPolls: number;
}

export const DEFAULT_CONFIG: SwitchConfig = {
  holdTtlSeconds: 600,
  maxTxnAmount: 10_000_000,
  stepTimeoutMs: 3000,
  inquiryTimeoutMs: 3000,
  maxAttempts: 3,
  retryBaseMs: 100,
  retryCapMs: 2000,
  parkBaseMs: 500,
  parkCapMs: 30000,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 5000,
  bulkheadLimit: 32,
  leaseMs: 10000,
  recoveryIntervalMs: 500,
  recoveryBatch: 50,
  deemedPollMs: 2000,
  deemedMaxPolls: 30,
};

export function configFromEnv(): SwitchConfig {
  const d = DEFAULT_CONFIG;
  return {
    holdTtlSeconds: envInt('SWITCH_HOLD_TTL_SECONDS', d.holdTtlSeconds),
    maxTxnAmount: envInt('SWITCH_MAX_TXN_PAISE', d.maxTxnAmount),
    stepTimeoutMs: envInt('SWITCH_STEP_TIMEOUT_MS', d.stepTimeoutMs),
    inquiryTimeoutMs: envInt('SWITCH_INQUIRY_TIMEOUT_MS', d.inquiryTimeoutMs),
    maxAttempts: envInt('SWITCH_MAX_ATTEMPTS', d.maxAttempts),
    retryBaseMs: envInt('SWITCH_RETRY_BASE_MS', d.retryBaseMs),
    retryCapMs: envInt('SWITCH_RETRY_CAP_MS', d.retryCapMs),
    parkBaseMs: envInt('SWITCH_PARK_BASE_MS', d.parkBaseMs),
    parkCapMs: envInt('SWITCH_PARK_CAP_MS', d.parkCapMs),
    breakerFailureThreshold: envInt('SWITCH_BREAKER_THRESHOLD', d.breakerFailureThreshold),
    breakerCooldownMs: envInt('SWITCH_BREAKER_COOLDOWN_MS', d.breakerCooldownMs),
    bulkheadLimit: envInt('SWITCH_BULKHEAD_LIMIT', d.bulkheadLimit),
    leaseMs: envInt('SWITCH_LEASE_MS', d.leaseMs),
    recoveryIntervalMs: envInt('SWITCH_RECOVERY_INTERVAL_MS', d.recoveryIntervalMs),
    recoveryBatch: envInt('SWITCH_RECOVERY_BATCH', d.recoveryBatch),
    deemedPollMs: envInt('SWITCH_DEEMED_POLL_MS', d.deemedPollMs),
    deemedMaxPolls: envInt('SWITCH_DEEMED_MAX_POLLS', d.deemedMaxPolls),
  };
}
