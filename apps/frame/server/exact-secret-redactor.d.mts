export function redactSecretText(value: unknown, secrets: string[]): string;

export function createExactSecretRedactor(secrets: string[]): {
  push(chunk: Uint8Array): Buffer;
  flush(): Buffer;
};

export function pipeRedactedBody(
  body: ReadableStream<Uint8Array> | null,
  destination: { write(chunk: Uint8Array): unknown },
  secrets: string[],
): Promise<void>;
