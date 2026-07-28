export type SealedConnectorSecret = Readonly<{
  keyId: string;
  wrappedKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}>;

export type ModelConnectorVaultOptions = Readonly<{
  secretsDir: string;
  masterKey: Uint8Array;
  returnUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  evidence?: (event: unknown) => void;
  now?: () => number;
}>;

export class ModelConnectorVault {
  constructor(options: ModelConnectorVaultOptions);
  ingressKey(app: string): { status: number; body: unknown };
  dispatch(input: {
    app: string; method: string; pathname: string; body?: unknown; signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
  handleOAuthCallback(input: {
    state?: string; code?: string; error?: string; signal?: AbortSignal;
  }): Promise<Readonly<{ status: 303; location: string }>>;
  invoke(input: {
    app: string; connectorId: string; payload: Record<string, unknown>; signal?: AbortSignal;
  }): Promise<Response>;
  close(): void;
}

export function createModelConnectorVault(options: ModelConnectorVaultOptions): ModelConnectorVault;
