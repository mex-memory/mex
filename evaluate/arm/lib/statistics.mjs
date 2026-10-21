const average = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Signed-rank check on task means, so repeated runs do not become independent tasks.
export function wilcoxon(values) {
  const a = values.filter((x) => Number.isFinite(x) && x !== 0).sort((x, y) => Math.abs(x) - Math.abs(y));
  if (!a.length) return { n: 0, w: 0, p: 1, method: "exact signed-rank" };
  const ranks = [];
  for (let i = 0; i < a.length;) {
    let j = i + 1;
    while (j < a.length && Math.abs(a[j]) === Math.abs(a[i])) j++;
    for (let k = i; k < j; k++) ranks[k] = (i + 1 + j) / 2;
    i = j;
  }
  const plus = ranks.reduce((s, r, i) => s + (a[i] > 0 ? r : 0), 0), total = ranks.reduce((s, r) => s + r, 0);
  const w = Math.min(plus, total - plus);
  if (a.length <= 40) {
    let counts = [1];
    for (const rank of ranks) {
      const step = rank * 2, next = Array(counts.length + step).fill(0);
      counts.forEach((n, i) => { next[i] += n; next[i + step] += n; });
      counts = next;
    }
    return { n: a.length, w, p: Math.min(1, 2 * counts.slice(0, Math.floor(w * 2) + 1).reduce((s, x) => s + x, 0) / 2 ** a.length), method: "exact signed-rank (ties retained)" };
  }
  const variance = ranks.reduce((s, r) => s + r * r, 0) / 4;
  const z = Math.max(0, Math.abs(plus - total / 2) - 0.5) / Math.sqrt(variance);
  const t = 1 / (1 + 0.2316419 * z);
  const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return { n: a.length, w, p: Math.min(1, 2 * tail), method: "normal signed-rank with tie variance" };
}

export function pairedRatio(pairs, key, { resamples = 10_000, seed = 17 } = {}) {
  const clusters = new Map();
  for (const pair of pairs) {
    const c = pair.control.metrics[key], t = pair.treatment.metrics[key];
    if (!(c > 0 && t > 0 && Number.isFinite(c) && Number.isFinite(t))) continue;
    const values = clusters.get(pair.taskId) ?? [];
    values.push(Math.log(t / c)); clusters.set(pair.taskId, values);
  }
  const values = [...clusters.values()].map(average);
  if (!values.length) return { ratio: null, low: null, high: null, tasks: 0, pairs: 0, wilcoxon: null };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const samples = [];
  if (values.length > 1) for (let r = 0; r < resamples; r++) samples.push(Math.exp(average(values.map(() => values[Math.floor(random() * values.length)]))));
  samples.sort((a, b) => a - b);
  return { ratio: Math.exp(average(values)), low: samples[Math.floor(resamples * .025)] ?? null, high: samples[Math.floor(resamples * .975)] ?? null,
    tasks: values.length, pairs: [...clusters.values()].reduce((s, a) => s + a.length, 0), wilcoxon: wilcoxon(values) };
}
