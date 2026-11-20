'use strict';

// Hysteria authentication belongs to the QUIC transport, not protocol.settings.
// Keep provider FinalMask parameters (for example BBR) in their native location.
function parseHysteria2LineToOutbound(line, index = 0) {
  const url = new URL(String(line));
  if (!['hysteria2:', 'hy2:'].includes(url.protocol)) throw new Error('Unsupported Hysteria version');
  const q = url.searchParams;
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 443);
  const auth = decodeURIComponent(url.username) + (url.password ? ':' + decodeURIComponent(url.password) : '');
  if (!address || !auth || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Hysteria 2 endpoint or authentication');
  // Do not silently publish a working-looking config with missing protection.
  if (['obfs', 'pinSHA256', 'ech', 'mport'].some(k => q.get(k))) throw new Error('Unsupported Hysteria 2 URI option');
  const streamSettings = {
    network: 'hysteria',
    security: 'tls',
    tlsSettings: {
      serverName: q.get('sni') || address,
      alpn: ['h3'],
      allowInsecure: q.get('insecure') === '1'
    },
    hysteriaSettings: { version: 2, auth }
  };
  if (q.get('fm')) {
    const finalmask = JSON.parse(q.get('fm'));
    if (!finalmask || typeof finalmask !== 'object' || Array.isArray(finalmask)) throw new Error('Invalid Hysteria 2 FinalMask');
    streamSettings.finalmask = finalmask;
  }
  // Keep idle QUIC sessions alive across mobile NATs; respect explicit provider values.
  streamSettings.finalmask = { ...(streamSettings.finalmask || {}), quicParams: {
    maxIdleTimeout: 60, keepAlivePeriod: 10, ...(streamSettings.finalmask?.quicParams || {})
  }};
  return {
    tag: index === 0 ? 'proxy' : `proxy-${index + 1}`,
    protocol: 'hysteria',
    settings: { version: 2, address, port },
    streamSettings
  };
}

module.exports = { parseHysteria2LineToOutbound };
