import type { AdapterStep } from '@kosh/contracts';
import { ServiceClient } from '@kosh/service-kit';

export interface BankStepStatus {
  step: string;
  status: 'IN_PROGRESS' | 'DONE' | 'FAILED';
  httpStatus: number | null;
  response: unknown;
}

export interface BankStatus {
  txnId: string;
  bankCode: string;
  steps: BankStepStatus[];
}

export interface BankPort {
  call(bank: string, step: AdapterStep, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  status(bank: string, txnId: string, timeoutMs: number): Promise<BankStatus>;
}

export function httpBankPort(adapterUrl: string, token: string): BankPort {
  const client = new ServiceClient(adapterUrl, { token, caller: 'switch-service' });
  return {
    call: (bank, step, body, timeoutMs) => client.post<Record<string, unknown>>(`/banks/${encodeURIComponent(bank)}/${step}`, body, { timeoutMs }),
    status: (bank, txnId, timeoutMs) => client.get<BankStatus>(`/banks/${encodeURIComponent(bank)}/status/${encodeURIComponent(txnId)}`, { timeoutMs }),
  };
}
