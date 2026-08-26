// builtin-servers/handlers/ops.js — họ op `ops.*`: deploy/scale/logs/k8s/docker/dns/pipeline/cost.
import { int, float, pick, picks, chance, hex, agoMs, isoAgo, clamp, str, word, semver, cap } from '../util.js';

const LOG_TEMPLATES = [
  ['INFO', 'request completed status=200 path=/api/v1/{x} dur={d}ms'],
  ['INFO', 'healthcheck ok (liveness) round={n}'],
  ['WARN', 'retrying upstream call attempt={n}/5 backoff=200ms'],
  ['ERROR', 'upstream timeout after {d}ms host={h}'],
  ['INFO', 'cache hit ratio={r} keys={n}'],
  ['WARN', 'gc pause {d}ms above p99 baseline'],
];

function renderLog(tpl, r) {
  return tpl
    .replaceAll('{x}', word(r))
    .replaceAll('{d}', String(int(r, 2, 1800)))
    .replaceAll('{n}', String(int(r, 1, 999)))
    .replaceAll('{h}', `${word(r)}.internal`)
    .replaceAll('{r}', `0.${int(r, 40, 95)}`);
}

export default {
  async deploy(args, r) {
    const service = str(args.service ?? args.app, 'web-app');
    return {
      deploymentId: `dep_${hex(r, 8)}`,
      service,
      env: str(args.env, 'staging'),
      version: str(args.version ?? args.tag, `v${semver(r)}`),
      status: 'progressing',
      etaSec: int(r, 45, 260),
      region: pick(r, ['ap-southeast-1', 'us-east-1', 'eu-west-2']),
      triggeredBy: 'pipeline',
    };
  },

  async scale_service(args, r) {
    const replicas = clamp(Math.round(Number(args.replicas) || 3), 1, 64);
    let previous = clamp(replicas + pick(r, [-2, -1, 1, 2]), 1, 64);
    if (previous === replicas) previous = clamp(replicas + 1, 1, 64);
    return {
      service: str(args.service, 'web-app'),
      previousReplicas: previous,
      replicas,
      status: 'scaling',
      etaSec: int(r, 10, 60),
      reason: pick(r, ['autoscaler', 'manual', 'scheduled']),
    };
  },

  async logs_tail(args, r) {
    const service = str(args.service, 'web-app');
    const lines = clamp(Math.round(Number(args.lines) || 12), 1, 50);
    const base = agoMs(r, 0.05);
    let step = int(r, 200, 1400);
    const entries = Array.from({ length: lines }, (_, i) => {
      const [level, tpl] = pick(r, LOG_TEMPLATES);
      step += int(r, 120, 1500);
      return { ts: new Date(base + step).toISOString(), level, msg: renderLog(tpl, r) };
    });
    return { service, lines: entries, count: entries.length };
  },

  async kubectl_get(args, r) {
    const resource = str(args.resource ?? args.kind, 'pods');
    const namespace = str(args.namespace, 'default');
    const items = Array.from({ length: int(r, 3, 8) }, () => ({
      name: `${str(args.resource ?? args.kind, 'app').replace(/s$/, '')}-${word(r)}-${hex(r, 5)}`,
      ready: chance(r, 0.85) ? '1/1' : `0/${int(r, 1, 2)}`,
      status: chance(r, 0.88) ? 'Running' : pick(r, ['CrashLoopBackOff', 'Pending']),
      restarts: int(r, 0, 7),
      age: `${int(r, 2, 59)}${pick(r, ['m', 'h', 'd'])}`,
      ip: `10.${int(r, 0, 42)}.${int(r, 0, 255)}.${int(r, 2, 254)}`,
    }));
    return { namespace, resource, items, total: items.length };
  },

  async docker_ps(args, r) {
    const IMAGES = ['nginx:1.27', 'redis:7', 'postgres:16', 'node:22-alpine', 'upio/executor:latest'];
    const containers = Array.from({ length: int(r, 2, 6) }, () => ({
      id: hex(r, 12),
      name: `${word(r)}-${word(r)}`,
      image: pick(r, IMAGES),
      status: chance(r, 0.82) ? `Up ${int(r, 2, 96)} hours` : `Exited (0) ${int(r, 1, 55)} minutes ago`,
      ports: `0.0.0.0:${int(r, 1024, 9999)}->${pick(r, [80, 443, 5432, 3000])}/tcp`,
    }));
    return {
      host: str(args.host, 'local'),
      containers,
      running: containers.filter((c) => c.status.startsWith('Up')).length,
      total: containers.length,
    };
  },

  async dns_lookup(args, r) {
    const domain = str(args.domain ?? args.hostname ?? args.host, 'example.com');
    const records = [
      { type: 'A', value: `${int(r, 13, 203)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 2, 254)}` },
    ];
    if (chance(r, 0.5)) records.push({ type: 'A', value: `${int(r, 13, 203)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 2, 254)}` });
    if (chance(r, 0.35)) records.push({ type: 'AAAA', value: `2606:4700::${hex(r, 4)}:${hex(r, 4)}:${hex(r, 4)}:${hex(r, 4)}` });
    if (chance(r, 0.6)) records.push({ type: 'MX', value: `10 mail.${domain}` });
    records.push({ type: 'TXT', value: `"v=spf1 include:_spf.${domain} ~all"` });
    return { domain, requestedType: str(args.type, 'ANY').toUpperCase(), records, ttlSec: int(r, 60, 3600), resolvedAtMs: agoMs(r, 0.01) };
  },

  async pipeline_run(args, r) {
    const project = str(args.project ?? args.pipeline, 'upio-core');
    const branch = str(args.branch, 'main');
    const STAGES = ['checkout', 'build', 'test', 'package', 'deploy'];
    const cut = int(r, 1, STAGES.length);
    const stages = STAGES.map((name, i) => ({
      name,
      state: i < cut - 1 ? 'succeeded' : i === cut - 1 ? 'running' : 'pending',
      durationSec: i < cut ? float(r, 4, 240, 1) : null,
    }));
    return {
      runId: `run_${hex(r, 8)}`,
      project,
      branch,
      status: 'running',
      startedAtMs: agoMs(r, 0.02),
      stages,
      url: `https://ci.upio.mock/${project}/runs/${hex(r, 6)}`,
    };
  },

  async cost_report(args, r) {
    const period = str(args.period, '2026-01');
    const names = picks(r, ['compute', 'object-storage', 'managed-postgres', 'cdn', 'observability', 'serverless'], int(r, 4, 6));
    let total = 0;
    const services = names.map((name) => {
      const usd = float(r, 40, 4200);
      total += usd;
      return { name, usd };
    });
    for (const s of services) s.sharePct = Number(((s.usd / total) * 100).toFixed(1));
    const topService = services.reduce((a, b) => (b.usd > a.usd ? b : a), services[0])?.name ?? null;
    return { period, currency: 'USD', totalUsd: Number(total.toFixed(2)), services, topService };
  },
};
