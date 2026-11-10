// SPDX-License-Identifier: MIT OR Apache-2.0
// The endpoint table: the one place that says which origins the harness knows, what each reaches, and in what role. The page (through
// web/plan.mjs), the summary (web/summarize-core.mjs) and scripts/proxy-latency.mjs all read it; nothing else may name a host
// (a test fails if another web source does). tests/node.test.mjs derives origin -> upstream from the proxy files and compares it with
// this table, and recomputes each file's sha256, so the table cannot say something the files do not route.
//
// An entry:
//   origin       what the page is given (a bare origin), or null while a hosted proxy has no hostname yet
//   hostname     the hosted proxy's host name, null until the hosted proxy is deployed
//   via          'proxy' (a gRPC-web proxy of ours in front of the upstream) or 'direct' (the upstream itself, if an operator grants CORS)
//   role         'verdict' (a live row may carry a verdict), 'pipeline' (checks of the pipeline only, never a verdict)
//   upstream     host:port the proxy forwards to, DECLARED here and in the proxy files. The harness does not observe it: the page records
//                it as upstream_declared, beside what the upstream itself says (GetLightdInfo, tree states, the end block hash).
//   files        sha256 of each proxy file, as a stranger recomputes with sha256sum; compose.yml names the image by digest
//   platform, edge_tls, region, image_digest   what a hosted proxy runs on; null until it is deployed (they are not hashed files)
// A direct entry has via 'direct', no files, and its role decided only after the operator's yes; none exists today.
// A proxy that anyone starts from proxy/ is reached by these same origins; it is the pipeline proxy and carries no verdict.

export const ENDPOINTS = [
  {
    origin: 'http://localhost:1234', hostname: null, via: 'proxy', role: 'pipeline', upstream: 'zec.rocks:443',
    files: {
      'proxy/compose.yml': '715a29b3de37924bc05ce9f532ae90586e5a8bbcaa0452690039fe2a99e82561',
      'proxy/traefik.yml': 'f2e4c2968c5dc9a589fb3ca1a6564b9bdbfa16e318c75ca001aabca0788857fe',
      'proxy/conf/dynamic.yml': '5e4e6be0c3335214deba4c348533b83f761dd5dc8cfd538157adabca3759d70e',
    },
  },
  {
    origin: 'http://localhost:1235', hostname: null, via: 'proxy', role: 'pipeline', upstream: 'zec.global:443',
    files: {
      'proxy/compose.yml': '715a29b3de37924bc05ce9f532ae90586e5a8bbcaa0452690039fe2a99e82561',
      'proxy/traefik.yml': 'f2e4c2968c5dc9a589fb3ca1a6564b9bdbfa16e318c75ca001aabca0788857fe',
      'proxy/conf/dynamic.yml': '5e4e6be0c3335214deba4c348533b83f761dd5dc8cfd538157adabca3759d70e',
    },
  },
  // The testnet variant (proxy/testnet/): to try the proxy and the latency script before any mainnet read. No verdict.
  {
    origin: 'http://localhost:1244', hostname: null, via: 'proxy', role: 'pipeline', upstream: 'testnet.zec.rocks:443',
    files: {
      'proxy/testnet/compose.yml': 'a16aee413d587aeb8600d5727730ed4f1be1ea9bd8c8fa1d5521aa78ae25c2a4',
      'proxy/testnet/traefik.yml': 'e7f74c01f5b4b8eb201b6fcee1c88b6d8b2f08336f9211df3b8d7651c1bb8199',
      'proxy/testnet/conf/dynamic.yml': 'c6c48d31cd1958a2c6126bbc2def4a46343f47054bb5df444dbdb691c10be946',
    },
  },
  // The hosted proxy for verdict runs. Filled in after the deploy: the hostname, platform, edge/TLS termination, region and image digest,
  // and the hashes of the hosted files. Until then no live row can carry a verdict: nothing matches a null origin.
  {
    origin: null, hostname: null, via: 'proxy', role: 'verdict', upstream: 'zec.rocks:443', files: {},
    platform: null, edge_tls: null, region: null, image_digest: null,
  },
];

// The origin an entry answers on. A hosted proxy is https on its host name.
export const originOf = (e) => e.origin ?? (e.hostname ? `https://${e.hostname}` : null);

// The entry for an endpoint the page was given. The caller passes a bare origin (web/endpoint.mjs); null when the table does not name it.
export function findEndpoint(origin, table = ENDPOINTS) {
  if (!origin) return null;
  return table.find((e) => originOf(e) === origin) ?? null;
}

// Whether an entry may carry a verdict: one definition, used by the summary and by the test of the table's shape. It names its host (the
// origin, if given, is that host over https), and a proxy also has its hashed files and says where it runs (platform, edge/TLS, region,
// image digest). That the hashes match the files is a test's job (tests/node.test.mjs recomputes them); a page cannot read them.
export const verdictReady = (e) => !!e && e.role === 'verdict' && typeof e.hostname === 'string' && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/.test(e.hostname) && (e.origin == null || e.origin === `https://${e.hostname}`)
  && (e.via === 'direct' || (Object.keys(e.files ?? {}).length > 0 && /^sha256:[0-9a-f]{64}$/.test(e.image_digest ?? '') && ['platform', 'edge_tls', 'region'].every((f) => String(e[f] ?? '').trim() !== '')));

// What a live row records from the table: declarations, not observations. Nothing when the table does not name the endpoint.
export function declaredFor(origin, table = ENDPOINTS) {
  const e = findEndpoint(origin, table);
  if (!e) return {};
  const host = e.via === 'proxy' && e.role === 'verdict' ? { proxy_host_declared: { platform: e.platform ?? null, edge_tls: e.edge_tls ?? null, region: e.region ?? null, image_digest: e.image_digest ?? null } } : {};
  return { upstream_declared: e.upstream, proxy_config_declared: e.files && Object.keys(e.files).length ? { ...e.files } : null, ...host };
}
