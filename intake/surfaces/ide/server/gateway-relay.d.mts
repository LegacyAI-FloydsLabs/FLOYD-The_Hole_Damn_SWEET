import type { IncomingMessage, ServerResponse } from 'node:http';
export interface GatewayOptions {
  allowedHosts?: string | string[];
  env?: Record<string, string | undefined>;
  requestUpstream?: (request: { url: string; headers: Record<string, string>; body: Buffer }) => {
    response: Promise<IncomingMessage>;
    abort(reason?: Error): void;
  };
}
export function handleGateway(req: IncomingMessage, res: ServerResponse, options?: GatewayOptions): Promise<void>;
