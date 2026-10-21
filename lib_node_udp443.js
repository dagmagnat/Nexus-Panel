'use strict';

// Client-side policy only. Never apply it to Remnawave/cascade or provider nodes.
function isOrdinary3xui(node) {
  return !!node && String(node.node_type || '3xui').toLowerCase() === '3xui';
}

function allowsUdp443(node) {
  return node?.allow_udp443 == null || Number(node.allow_udp443) === 1;
}

function udp443FormValue(body, existingNode) {
  if (String(body?.udp443_controls || '') !== '1') {
    return allowsUdp443(existingNode) ? 1 : 0;
  }
  return body.allow_udp443 === '1' ? 1 : 0;
}

function supportsVisionFlow(flow, network, security) {
  return ['raw', 'tcp'].includes(String(network).toLowerCase()) &&
    ['tls', 'reality'].includes(String(security).toLowerCase()) &&
    ['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(flow);
}

function nodeVisionFlow(flow, node, network, security) {
  if (!isOrdinary3xui(node) || !supportsVisionFlow(flow, network, security)) return flow;
  return allowsUdp443(node) ? 'xtls-rprx-vision-udp443' : 'xtls-rprx-vision';
}

function applyNodeUdp443(outbound, node, sourceFlow = '') {
  if (!outbound || outbound.protocol !== 'vless' || !isOrdinary3xui(node)) return outbound;
  const stream = outbound.streamSettings || {};
  for (const server of outbound.settings?.vnext || []) {
    for (const user of server.users || []) {
      // Do not introduce flow into XHTTP, WS, gRPC or flow-less VLESS.
      if (user.flow) user.flow = nodeVisionFlow(user.flow, node, stream.network, stream.security);
      else if (supportsVisionFlow(sourceFlow, stream.network, stream.security)) {
        user.flow = nodeVisionFlow(sourceFlow, node, stream.network, stream.security);
      }
    }
  }
  // Preserve enabled/concurrency and all other inherited fields. This does not
  // create Mux: skip uses VLESS's own UDP transport, not TCP multiplexing.
  if (outbound.mux && typeof outbound.mux === 'object' && !Array.isArray(outbound.mux)) {
    outbound.mux.xudpProxyUDP443 = allowsUdp443(node) ? 'skip' : 'reject';
  }
  return outbound;
}

module.exports = { allowsUdp443, udp443FormValue, nodeVisionFlow, applyNodeUdp443 };
