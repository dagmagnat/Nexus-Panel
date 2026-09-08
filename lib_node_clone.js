'use strict';
// Explicit allowlist: never inherit runtime status, registrations or client data.
const CONNECTION_FIELDS = ('name node_type panel_url panel_path sub_base_url username password_enc api_auth_mode api_token_enc remnawave_caddy_token_enc remnawave_internal_squad_uuid remnawave_link_mode remnawave_remark_mode inbound_id country_code country_name_ru country_flag label_suffix sni_mode sni_profile_id sni_override inherit_3xui_mux inherit_3xui_fragment inherit_3xui_noises h1cloud_link_mode h1cloud_link_types h1cloud_fingerprint h1cloud_xhttp_backend_path h1cloud_xhttp_method h1cloud_xhttp_alpn h1cloud_cdn_host h1cloud_cdn_sni h1cloud_cdn_port h1cloud_cdn_tag h1cloud_cdn_public_path h1cloud_reality_port h1cloud_reality_public_port h1cloud_reality_sni h1cloud_reality_dest h1cloud_3xui_shared_traffic h1cloud_3xui_json_url_template h1cloud_3xui_local_expiry h1cloud_3xui_sub_port').split(' ');
function nodeCloneValues(source, sortOrder) {
  const copy = Object.fromEntries(CONNECTION_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return { ...copy, label_suffix: `${String(source.label_suffix || '').trim()} (копия)`.trim(),
    enabled: 0, last_status: 'unknown', last_error: '', sort_order: sortOrder };
}
module.exports = { nodeCloneValues };
