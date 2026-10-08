/**
 * Valor de uma amostra no formato texto do Prometheus, achando a linha pelo nome e pelo
 * conjunto exato de rotulos, em qualquer ordem. undefined se nao existir.
 */
export function sample(body: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of body.split("\n")) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const found = Object.fromEntries([...(match[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const sameLabels =
      Object.keys(found).length === Object.keys(labels).length && Object.entries(labels).every(([k, v]) => found[k] === v);
    if (sameLabels) return Number(match[3]);
  }
  return undefined;
}
