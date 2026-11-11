// SPDX-License-Identifier: MIT OR Apache-2.0
// Reads the proxy files the way the proxy does and says which origin reaches which upstream. The repository has no package.json,
// so this is a reader for the small subset of YAML those files use (maps, lists, flow lists, quoted or plain scalars, comments).
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const scalar = (s) => {
  s = s.trim();
  if (s === '{}') return {};
  // What this reader does not read it refuses, so a line it would skip cannot hide anything.
  if (/^[&*!|>]/.test(s) || (s.startsWith('{') && s !== '{}') || (s.startsWith('[') !== s.endsWith(']') && /^\[|\]$/.test(s))) throw new Error(`cannot read: ${s}`);
  if (s.startsWith('[')) return s.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '');
  if (/^(".*"|'.*')$/.test(s)) return s.slice(1, -1);
  return s;
};

// A comment starts at a # that follows a space and is outside quotes; a quote opens only where a scalar starts.
const uncomment = (l) => {
  let q = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s\[,:]/.test(l[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i);
  }
  return l;
};

export function parseYaml(text) {
  const lines = text.split('\n').map((l) => uncomment(l).replace(/\s+$/, '')).filter((l) => l.trim() !== '').map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const node = (indent) => {
    if (lines[i].text.startsWith('- ')) {
      const out = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
        const rest = lines[i].text.slice(2);
        if (/^[\w-]+:( |$)/.test(rest)) { lines[i] = { indent: indent + 2, text: rest }; out.push(node(indent + 2)); } else { out.push(scalar(rest)); i++; }
      }
      return out;
    }
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const m = /^([^:]+):(?: (.*))?$/.exec(lines[i].text);
      if (!m) throw new Error(`cannot read: ${lines[i].text}`);
      i++;
      // A key twice, or two keys that differ only in case, is a file that reads one way here and may read another way there.
      if (Object.keys(out).some((k) => k.toLowerCase() === m[1].toLowerCase())) throw new Error(`a key twice: ${m[1]}`);
      if (m[2] !== undefined) out[m[1]] = scalar(m[2]);
      else if (i < lines.length && lines[i].indent > indent) out[m[1]] = node(lines[i].indent);
      else out[m[1]] = null;
    }
    return out;
  };
  const root = node(lines[0].indent);
  // Every line is read or the file is refused: a line that is deeper than expected must not end the reading and drop the rest.
  if (i !== lines.length) throw new Error(`cannot read: ${lines[i].text}`);
  return root;
}

export const sha256 = (path, root) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

// What a router may carry: the four calls the harness makes (web/grpcweb.js, scripts/proxy-latency.mjs) as POST, and OPTIONS for the browser's
// preflight on those same paths. Every other method and path, SendTransaction and the address and mempool calls included, is not routed.
export const SERVICE_PATH = '/cash.z.wallet.sdk.rpc.CompactTxStreamer/';
export const ALLOWED_METHODS = ['GetLatestBlock', 'GetBlockRange', 'GetTreeState', 'GetLightdInfo'];
export const ROUTER_RULE = `(Method(\`POST\`) || Method(\`OPTIONS\`)) && (${ALLOWED_METHODS.map((m) => `Path(\`${SERVICE_PATH}${m}\`)`).join(' || ')})`;
// In front of the proxy: a rate that limits, and a burst that holds one run.
const RATE_KEYS = ['average', 'burst', 'period'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const only = (obj, allowed, what) => { for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${what}: ${k} is not an allowed key`); };

// origin -> upstream, as the files route it: published port -> entry point -> router -> service -> server url. It throws on anything
// Traefik would load or choose differently from what this reads: a key it does not know, a mount other than the two it hashes, a
// provider other than the one file, a second router (the rule length, not the order in the file, picks the router), an upstream in clear.
export function deriveRoutes(files, root) {
  const path = (suffix) => { const p = Object.keys(files).find((f) => f.endsWith(suffix)); if (!p) throw new Error(`no ${suffix} in the entry's files`); return p; };
  const read = (suffix) => parseYaml(readFileSync(join(root, path(suffix)), 'utf8'));
  const compose = read('compose.yml'), stat = read('traefik.yml'), dyn = read('dynamic.yml');
  only(compose, ['name', 'services'], 'compose');
  only(compose.services, ['traefik'], 'compose services');
  for (const s of Object.values(compose.services)) {
    if (!/^traefik:v3\.7\.\d+@sha256:[0-9a-f]{64}$/.test(s.image)) throw new Error('compose: the image is not the pinned traefik');
    only(s, ['image', 'container_name', 'restart', 'network_mode', 'ports', 'volumes'], 'compose service');
    if (!same(s.volumes, ['./traefik.yml:/etc/traefik/traefik.yml:ro', './conf:/etc/traefik/conf:ro'])) throw new Error('compose: the volumes are not the two hashed files');
  }
  only(stat, ['global', 'log', 'accessLog', 'entryPoints', 'providers'], 'traefik.yml');
  // No call home: Traefik would otherwise ask the internet for the latest version when it starts.
  if (!same(stat.global, { sendAnonymousUsage: 'false', checkNewVersion: 'false' })) throw new Error('traefik.yml: global must be exactly sendAnonymousUsage false and checkNewVersion false');
  if (!same(stat.providers, { file: { filename: '/etc/traefik/conf/dynamic.yml' } })) throw new Error('traefik.yml: the only provider must be the one file');
  const conf = dirname(join(root, path('dynamic.yml')));
  if (!same(readdirSync(conf).sort(), ['dynamic.yml'])) throw new Error('conf/ holds more than dynamic.yml');
  only(dyn, ['http'], 'dynamic.yml');
  only(dyn.http, ['routers', 'middlewares', 'services'], 'dynamic.yml http');
  // Every level this reads is closed: a key it does not read is a key that could change the routing.
  for (const [n, ep] of Object.entries(stat.entryPoints)) only(ep, ['address'], `entry point ${n}`);
  for (const [n, r] of Object.entries(dyn.http.routers)) only(r, ['rule', 'service', 'middlewares', 'entryPoints'], `router ${n}`);
  // Two middlewares, each of one known kind with its own closed keys: the proxy, and the rate limit in front of it.
  if (!same(Object.keys(dyn.http.middlewares).sort(), ['grpc-web', 'rate-limit'])) throw new Error('the middlewares are not exactly grpc-web and rate-limit');
  const gw = dyn.http.middlewares['grpc-web'], rl = dyn.http.middlewares['rate-limit'];
  only(gw, ['grpcWeb'], 'middleware grpc-web'); only(gw.grpcWeb, ['allowOrigins'], 'middleware grpc-web');
  only(rl, ['rateLimit'], 'middleware rate-limit'); only(rl.rateLimit, RATE_KEYS, 'middleware rate-limit');
  if (!same(Object.keys(rl.rateLimit).sort(), RATE_KEYS)) throw new Error('rate-limit: average, burst and period are all required');
  if (!/^[1-9]\d*$/.test(rl.rateLimit.average) || !/^[1-9]\d*$/.test(rl.rateLimit.burst) || !/^[1-9]\d*(s|m)$/.test(rl.rateLimit.period)) throw new Error('rate-limit: average and burst are whole numbers above 0, period is seconds or minutes');
  for (const [n, sv] of Object.entries(dyn.http.services)) {
    only(sv, ['loadBalancer'], `service ${n}`);
    only(sv.loadBalancer, ['servers'], `service ${n} loadBalancer`);
    for (const x of sv.loadBalancer.servers ?? []) only(x, ['url'], `service ${n} server`);
  }
  const published = {};
  for (const spec of Object.values(compose.services).flatMap((s) => s.ports ?? [])) {
    const [bind, host, container] = String(spec).split(':');
    if (published[container]) throw new Error(`container port ${container} is published twice`);
    published[container] = { bind, host };
  }
  // Exactly one router for each entry point: with one, there is no priority to argue about.
  for (const ep of Object.keys(stat.entryPoints)) {
    const mine = Object.values(dyn.http.routers).filter((r) => r.entryPoints.includes(ep));
    if (mine.length !== 1) throw new Error(`entry point ${ep}: ${mine.length} routers, not exactly one`);
  }
  const routes = {};
  for (const r of Object.values(dyn.http.routers)) {
    if (r.rule !== ROUTER_RULE) throw new Error(`router rule ${r.rule} is not the four calls the harness makes`);
    if (!same(r.middlewares, ['rate-limit', 'grpc-web'])) throw new Error('a router must have the rate limit, then the proxy, and nothing else');
    const urls = (dyn.http.services[r.service].loadBalancer.servers ?? []).map((s) => new URL(s.url));
    if (urls.length !== 1) throw new Error('a service must have exactly one server');
    if (urls[0].protocol !== 'https:') throw new Error('an upstream must be https');
    for (const ep of r.entryPoints) {
      const port = String(stat.entryPoints[ep].address).replace(/^:/, '');
      const p = published[port];
      if (!p) continue;
      routes[`http://localhost:${p.host}`] = `${urls[0].hostname}:${urls[0].port || 443}`;
    }
  }
  return { routes, compose, stat, dyn, published };
}

// The hosted variant (proxy/hosted/<name>/): a Dockerfile that pins the image and copies two files, one entry point, one router, one service.
// Returns the upstream the files route to, the digest the Dockerfile pins, and the two settings the rate limit depends on. It throws on anything
// it does not read, as deriveRoutes does.
export function deriveHosted(files, root) {
  const path = (suffix) => { const p = Object.keys(files).find((f) => f.endsWith(suffix)); if (!p) throw new Error(`no ${suffix} in the entry's files`); return p; };
  const text = (suffix) => readFileSync(join(root, path(suffix)), 'utf8');
  const docker = text('Dockerfile').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const from = /^FROM (traefik:v3\.7\.\d+)@(sha256:[0-9a-f]{64})$/.exec(docker[0] ?? '');
  if (!from) throw new Error('Dockerfile: the image is not the pinned traefik');
  if (!same(docker.slice(1), ['COPY traefik.yml /etc/traefik/traefik.yml', 'COPY conf/dynamic.yml /etc/traefik/conf/dynamic.yml'])) throw new Error('Dockerfile: it must copy exactly the two hashed files');
  const stat = parseYaml(text('traefik.yml')), dyn = parseYaml(text('dynamic.yml'));
  only(stat, ['global', 'log', 'entryPoints', 'providers'], 'traefik.yml');
  if (stat.accessLog !== undefined) throw new Error('traefik.yml: accessLog');
  if (!same(stat.global, { sendAnonymousUsage: 'false', checkNewVersion: 'false' })) throw new Error('traefik.yml: global must be exactly sendAnonymousUsage false and checkNewVersion false');
  if (!same(stat.providers, { file: { filename: '/etc/traefik/conf/dynamic.yml' } })) throw new Error('traefik.yml: the only provider must be the one file');
  if (!same(Object.keys(stat.entryPoints), ['web'])) throw new Error('traefik.yml: exactly one entry point, web');
  const ep = stat.entryPoints.web;
  only(ep, ['address', 'http', 'forwardedHeaders'], 'entry point web');
  if (!same(ep.http, { aliasHeadersStrategy: 'delete' })) throw new Error('entry point web: aliasHeadersStrategy must be delete');
  if (!same(ep.forwardedHeaders, { trustedIPs: ['100.64.0.0/10'] })) throw new Error('entry point web: trustedIPs must be exactly 100.64.0.0/10');
  only(dyn, ['http'], 'dynamic.yml');
  only(dyn.http, ['routers', 'middlewares', 'services'], 'dynamic.yml http');
  const routers = Object.values(dyn.http.routers);
  if (routers.length !== 1) throw new Error('exactly one router');
  const [r] = routers;
  only(r, ['rule', 'service', 'middlewares', 'entryPoints'], 'router');
  if (r.rule !== ROUTER_RULE) throw new Error('router rule is not the four calls the harness makes');
  if (!same(r.middlewares, ['rate-limit', 'grpc-web']) || !same(r.entryPoints, ['web'])) throw new Error('a router must have the rate limit, then the proxy, on web');
  if (!same(Object.keys(dyn.http.middlewares).sort(), ['grpc-web', 'rate-limit'])) throw new Error('the middlewares are not exactly grpc-web and rate-limit');
  const gw = dyn.http.middlewares['grpc-web'], rl = dyn.http.middlewares['rate-limit'];
  only(gw, ['grpcWeb'], 'middleware grpc-web'); only(gw.grpcWeb, ['allowOrigins'], 'middleware grpc-web');
  only(rl, ['rateLimit'], 'middleware rate-limit'); only(rl.rateLimit, [...RATE_KEYS, 'sourceCriterion'], 'middleware rate-limit');
  if (rl.rateLimit.average !== '20' || rl.rateLimit.period !== '1s' || rl.rateLimit.burst !== '40') throw new Error('rate-limit: average 20, period 1s, burst 40');
  if (!same(rl.rateLimit.sourceCriterion, { requestHeaderName: 'X-Real-IP' })) throw new Error('rate-limit: keyed on X-Real-IP');
  const sv = dyn.http.services[r.service];
  only(sv, ['loadBalancer'], 'service'); only(sv.loadBalancer, ['servers'], 'service loadBalancer');
  const urls = (sv.loadBalancer.servers ?? []).map((s) => { only(s, ['url'], 'server'); return new URL(s.url); });
  if (urls.length !== 1) throw new Error('a service must have exactly one server');
  if (urls[0].protocol !== 'https:') throw new Error('an upstream must be https');
  return { upstream: `${urls[0].hostname}:${urls[0].port || 443}`, image_digest: from[2], allowOrigins: gw.grpcWeb.allowOrigins, rateLimit: rl.rateLimit, dyn, stat };
}
