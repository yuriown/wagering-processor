import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import {
  COUNTERS,
  type CounterLabels,
  type CounterName,
  HISTOGRAMS,
  type HistogramLabels,
  type HistogramName,
} from "../../application/metrics-catalog";
import type { Metrics } from "../../application/ports";

/** Fonte de um gauge lido na hora da coleta (ex.: consulta ao banco). Falha vira NaN, nao derruba o scrape. */
export interface GaugeSource {
  name: string;
  help: string;
  read: () => Promise<number>;
}

/**
 * Adaptador Prometheus da porta Metrics. Registro proprio por instancia da aplicacao
 * (nada global), exposto em GET /metrics.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor(options: { defaultMetrics?: boolean; instanceId?: string } = {}) {
    if (options.instanceId !== undefined) this.registry.setDefaultLabels({ instance_id: options.instanceId });
    for (const [name, spec] of Object.entries(COUNTERS)) {
      this.counters.set(name, new Counter({ name, help: spec.help, labelNames: [...spec.labels], registers: [this.registry] }));
    }
    for (const [name, spec] of Object.entries(HISTOGRAMS)) {
      this.histograms.set(
        name,
        new Histogram({ name, help: spec.help, labelNames: [...spec.labels], buckets: [...spec.buckets], registers: [this.registry] }),
      );
    }
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
  }

  increment<N extends CounterName>(name: N, labels?: CounterLabels<N>, value = 1): void {
    this.counters.get(name)?.inc((labels ?? {}) as Record<string, string>, value);
  }

  observe<N extends HistogramName>(name: N, value: number, labels?: HistogramLabels<N>): void {
    this.histograms.get(name)?.observe((labels ?? {}) as Record<string, string>, value);
  }

  addGauge(source: GaugeSource): void {
    new Gauge({
      name: source.name,
      help: source.help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await source.read());
        } catch {
          this.set(Number.NaN);
        }
      },
    });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
