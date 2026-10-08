import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

/** Resolve a URL de cada fila uma vez e guarda; se falhar, tenta de novo na proxima chamada. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (url === undefined) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((r) => {
        if (!r.QueueUrl) throw new Error(`fila ${queueName} sem URL`);
        return r.QueueUrl;
      });
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}
