import { type Subprocess, spawn } from "bun";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const BUN = process.execPath;

export interface Instance {
  readonly name: string;
  readonly url: string;
  readonly proc: Subprocess;
  logs(): string;
  /** SIGKILL: morte sem shutdown gracioso (simula crash). */
  kill(): Promise<number>;
  /** SIGTERM: shutdown gracioso. */
  terminate(): Promise<number>;
  exited: Promise<number>;
}

export interface InstanceEnv {
  databaseUrl: string;
  queueName: string;
  dlqName: string;
  eventsQueueName: string;
  maxReceiveCount: number;
  workers?: string;
  extra?: Record<string, string>;
}

/**
 * Sobe `bun src/main.ts` como processo separado, com porta escolhida pelo sistema,
 * e espera a linha "http pronto" do log. Instancias sao processos de verdade:
 * nada em memoria e compartilhado, so Postgres e SQS.
 */
export async function startInstance(name: string, env: InstanceEnv, timeoutMs = 30_000): Promise<Instance> {
  const proc = spawn([BUN, "src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      INSTANCE_ID: name,
      DATABASE_URL: env.databaseUrl,
      SQS_QUEUE_NAME: env.queueName,
      SQS_DLQ_NAME: env.dlqName,
      SQS_EVENTS_QUEUE_NAME: env.eventsQueueName,
      SQS_MAX_RECEIVE_COUNT: String(env.maxReceiveCount),
      SQS_WAIT_TIME_SECONDS: "1",
      OUTBOX_IDLE_DELAY_MS: "100",
      REFERENCES_IDLE_DELAY_MS: "200",
      WORKERS: env.workers ?? "consumer,outbox,references",
      ...env.extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  const deadline = Date.now() + timeoutMs;
  let url: string | undefined;
  while (url === undefined) {
    const line = output.split("\n").find((l) => l.includes('"message":"http pronto"'));
    if (line !== undefined) {
      url = (JSON.parse(line) as { url: string }).url.replace("[::1]", "127.0.0.1");
      break;
    }
    if (proc.exitCode !== null) throw new Error(`${name} saiu com ${proc.exitCode} antes de ficar pronta:\n${output}`);
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`${name} nao ficou pronta em ${timeoutMs} ms:\n${output}`);
    }
    await Bun.sleep(50);
  }

  return {
    name,
    url,
    proc,
    logs: () => output,
    exited: proc.exited,
    async kill() {
      proc.kill("SIGKILL");
      return proc.exited;
    },
    async terminate() {
      proc.kill("SIGTERM");
      return proc.exited;
    },
  };
}

/** Espera uma condicao assincrona, com prazo. */
export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando: ${what}`);
    await Bun.sleep(intervalMs);
  }
}

export async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
