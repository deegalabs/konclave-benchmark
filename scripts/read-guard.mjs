// SPDX-License-Identifier: MIT OR Apache-2.0
// The one rule for every script that can reach a light client server: a read of the chain needs --read-approved, for any endpoint that is
// not this repository's own mock (scripts/mock-lightwalletd.mjs). A name on this machine is not the mock: a proxy of proxy/ listens on
// localhost and reaches the chain. The mock is only taken on the operator's word (--own-mock), only on this machine, and never on a port
// the endpoint table names for a local proxy, however the address is spelled: every entry of the table is a proxy to a public server.
import { isLocalEndpoint } from '../web/summarize-core.mjs';
import { ENDPOINTS, originOf } from '../web/endpoints.mjs';
import { bareOrigin } from '../web/endpoint.mjs';

export function requireReadApproval(endpoint, { readApproved = false, ownMock = false } = {}) {
  if (readApproved) return;
  // The port of every proxy of the table, on whatever local spelling (localhost, 127.x, [::1], 0.0.0.0): the compose files publish them on 127.0.0.1.
  const origin = bareOrigin(endpoint);
  const portOf = (o) => { try { const u = new URL(o); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch { return null; } };
  const proxyPorts = new Set(ENDPOINTS.map(originOf).filter((o) => o && isLocalEndpoint(o)).map(portOf));
  const mock = ownMock && isLocalEndpoint(endpoint) && origin !== null && !proxyPorts.has(portOf(origin));
  if (mock) return;
  let host = String(endpoint);
  try { host = new URL(endpoint).host; } catch { /* the text as given */ }
  throw new Error(`${host} may reach the chain: pass --read-approved once that read is approved (only the repo's own mock, with --own-mock, is read without it; a local proxy is not the mock)`);
}
