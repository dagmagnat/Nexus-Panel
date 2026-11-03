'use strict';
function booleanHint(value) {
  if (value === true || value === 1 || /^(true|1)$/i.test(String(value))) return true;
  if (value === false || value === 0 || /^(false|0)$/i.test(String(value))) return false;
  return null;
}
function mlkemFormValue(body, existing = {}) {
  if (body.reality_compat_controls !== '1') return existing.reality_mlkem_hint == null ? 1 : Number(existing.reality_mlkem_hint) === 1 ? 1 : 0;
  return body.reality_mlkem_hint === '1' ? 1 : 0;
}
function appendRealityHint(query, node = {}, reality = {}) {
  if (query.get('security') !== 'reality') { query.delete('support-x25519mlkem768'); return; }
  const nested = reality.settings || {};
  const source = booleanHint(nested.supportX25519Mlkem768 ?? reality.supportX25519Mlkem768 ?? nested.supportX25519MLKEM768 ?? reality.supportX25519MLKEM768);
  const enabled = (node.reality_mlkem_hint == null || Number(node.reality_mlkem_hint) === 1) && source !== false;
  if (enabled) query.set('support-x25519mlkem768', 'true');
  else query.delete('support-x25519mlkem768');
}
module.exports = { booleanHint, mlkemFormValue, appendRealityHint };
