'use strict';

// Short imported IDs remain on legacy routes. Reserve administrative names;
// a subscription must never shadow a login, API or management route.
const RESERVED = new Set(('access api auto-select-profiles backup clients css dashboard diagnostics favicon.ico flags happ happ-routing happ-routing-json healthz hiddify img js json login logout mobile-login more node-traffic nodes open operations preferences qr redirects routing s settings site.webmanifest sub sub-plain telegram vpn').split(' '));
const CLEAN_SLUG = /^[A-Za-z0-9_-]{12,128}$/;

function cleanSlug(slug) {
  return typeof slug === 'string' && CLEAN_SLUG.test(slug) && !RESERVED.has(slug.toLowerCase());
}

function subscriptionUrl(base, slug, format = 'json', cleanEnabled = true) {
  if (!slug) return '';
  const key = encodeURIComponent(String(slug));
  if (!cleanEnabled || !cleanSlug(String(slug))) return `${base}/${format === 'sub' ? 'sub' : 'json'}/${key}`;
  return `${base}/${key}${format === 'sub' ? '?format=sub' : ''}`;
}

function cleanSubscriptionTarget(url) {
  const q = String(url).indexOf('?');
  const pathname = q < 0 ? String(url) : String(url).slice(0, q);
  const match = pathname.match(/^\/([A-Za-z0-9_-]{12,128})\/?$/);
  if (!match || !cleanSlug(match[1])) return null;
  const params = new URLSearchParams(q < 0 ? '' : String(url).slice(q + 1));
  // Keep format=single working for existing JSON clients. Reject ambiguous
  // format values instead of silently returning a different subscription type.
  const formats = params.getAll('format');
  if (formats.length > 1 || (formats.length && !['json', 'sub', 'single'].includes(formats[0]))) {
    return { error: 'Unsupported subscription format' };
  }
  const isSub = formats[0] === 'sub';
  if (formats[0] !== 'single') params.delete('format');
  const search = params.toString();
  return { url: `/${isSub ? 'sub' : 'json'}/${match[1]}${search ? '?' + search : ''}` };
}

module.exports = { cleanSlug, subscriptionUrl, cleanSubscriptionTarget, RESERVED };
