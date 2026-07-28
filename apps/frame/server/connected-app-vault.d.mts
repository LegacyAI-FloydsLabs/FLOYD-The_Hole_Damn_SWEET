export type ConnectedAppVaultDispatch = Readonly<{
  app: string;
  method: string;
  pathname: string;
  body?: unknown;
  signal?: AbortSignal;
}>;

export type ConnectedAppVaultResult = Readonly<{
  status: number;
  body: unknown;
}>;

export type ConnectedAppVaultOptions = Readonly<{
  secretsDir: string;
  masterKey: Uint8Array;
  returnUrl: string;
  fetchImpl?: typeof globalThis.fetch;
  evidence?: (event: unknown) => void;
  now?: () => number;
}>;

export class ConnectedAppVault {
  constructor(options: ConnectedAppVaultOptions);
  dispatch(input: ConnectedAppVaultDispatch): Promise<ConnectedAppVaultResult>;
  handleOAuthCallback(input: {
    state?: string;
    code?: string;
    error?: string;
    signal?: AbortSignal;
  }): Promise<Readonly<{ status: 303; location: string }>>;
  close(): Promise<void>;
}

export function createConnectedAppVault(options: ConnectedAppVaultOptions): ConnectedAppVault;
