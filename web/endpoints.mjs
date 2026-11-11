// SPDX-License-Identifier: MIT OR Apache-2.0
// The endpoint table: the one place that says which origins the harness knows, what each reaches, and in what role. The page (through
// web/plan.mjs), the summary (web/summarize-core.mjs) and scripts/proxy-latency.mjs all read it; nothing else may name a host
// (a test fails if another web source does). tests/node.test.mjs derives origin -> upstream from the proxy files and compares it with
// this table, and recomputes each file's sha256, so the table cannot say something the files do not route.
//
// An entry:
//   origin       what the page is given (a bare origin)
//   hostname     the hosted proxy's host name (null for a proxy on this machine)
//   via          'proxy' (a gRPC-web proxy of ours in front of the upstream) or 'direct' (the upstream itself, if an operator grants CORS)
//   role         'verdict' (a live row may carry a verdict), 'pipeline' (checks of the pipeline only, never a verdict)
//   upstream     host:port the proxy forwards to, DECLARED here and in the proxy files. The harness does not observe it: the page records
//                it as upstream_declared, beside what the upstream itself says (GetLightdInfo, tree states, the end block hash).
//   files        sha256 of each proxy file, as a stranger recomputes with sha256sum; compose.yml (Dockerfile for a hosted proxy) names the image by digest
//   platform, edge_tls, region, image_digest   what a hosted proxy runs on (not hashed files); image_digest is the base image the Dockerfile pins
// A direct entry has via 'direct', no files, and its role decided only after the operator's yes; none exists today.
// A proxy that anyone starts from proxy/ is reached by these same origins; it is the pipeline proxy and carries no verdict.

const HOSTED_PLATFORM = 'Railway';
const HOSTED_EDGE_TLS = 'TLS ends at the Railway edge; the container serves plain http on :8080';
const HOSTED_REGION = 'container region not read (Railway default); edge regions seen: gru1, us-east4';
const HOSTED_IMAGE_DIGEST = 'sha256:f4bb143d1135a579b630ed491e17ec50f6f7c9c6a30585ff3d385471d2a86f5a';

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
  // The hosted proxies for verdict runs (Railway), one per upstream. The hashes are those of the files as committed, which are the files as
  // deployed: they carry no SPDX line, so that the hash in this table is the hash of what runs. image_digest is the base image the Dockerfile
  // pins (a test compares the two); the digest of the built image is not recorded here.
  {
    origin: 'https://m1-rocks.konclave.xyz', hostname: 'm1-rocks.konclave.xyz', via: 'proxy', role: 'verdict', upstream: 'zec.rocks:443',
    files: {
      'proxy/hosted/rocks/Dockerfile': '28fa4b515e29a4ba1ccb6e88f245e8e08a7c08059eced036e6a1464497910e4f',
      'proxy/hosted/rocks/traefik.yml': '73a72042bf4d14cb1f22ba0f2b8b3e46bb30e3b547f4cc02dfe52f84582f6008',
      'proxy/hosted/rocks/conf/dynamic.yml': '336d1426a795c8d999660c21f85010aee229c569b8ec371ae6559b204025c995',
    },
    platform: HOSTED_PLATFORM, edge_tls: HOSTED_EDGE_TLS, region: HOSTED_REGION, image_digest: HOSTED_IMAGE_DIGEST,
  },
  {
    origin: 'https://m1-global.konclave.xyz', hostname: 'm1-global.konclave.xyz', via: 'proxy', role: 'verdict', upstream: 'zec.global:443',
    files: {
      'proxy/hosted/global/Dockerfile': '28fa4b515e29a4ba1ccb6e88f245e8e08a7c08059eced036e6a1464497910e4f',
      'proxy/hosted/global/traefik.yml': '73a72042bf4d14cb1f22ba0f2b8b3e46bb30e3b547f4cc02dfe52f84582f6008',
      'proxy/hosted/global/conf/dynamic.yml': 'fda0961dfcf23dc2fc6f1aff697677b60690b693e9a49219c28d697c595e1a9e',
    },
    platform: HOSTED_PLATFORM, edge_tls: HOSTED_EDGE_TLS, region: HOSTED_REGION, image_digest: HOSTED_IMAGE_DIGEST,
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
