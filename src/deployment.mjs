const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Startup gate. The rule is not "never run in production" — it is "do not run
 * exposed unless the two controls that make exposure survivable are actually
 * configured": durable persistence, and a workspace secret without which every
 * route is refused.
 *
 * Both are required together. Durable storage without a secret is a public
 * database of other people's events; a secret without durable storage loses the
 * data on the next restart and still has no per-user authorization.
 */
export function assertSafeDeployment({
  nodeEnv = 'development',
  host = '127.0.0.1',
  persistence = 'file',
  accessKey = '',
  requireAccessKey = true
} = {}) {
  const loopback = LOOPBACK_HOSTS.has(host);
  const durable = persistence === 'supabase';
  const secret = String(accessKey || '').trim();

  if (nodeEnv === 'production') {
    const missing = [];
    if (!durable) missing.push('durable persistence (set SUPABASE_REST_URL and SUPABASE_SERVICE_ROLE_KEY)');
    if (requireAccessKey && secret.length < 16) missing.push('a workspace secret of at least 16 characters (set EVENTPILOT_ACCESS_KEY)');
    if (missing.length) {
      throw new Error(`Production startup blocked — still missing: ${missing.join('; ')}.`);
    }
    return { secure: true, persistence, host };
  }

  if (!loopback && !(durable && secret.length >= 16)) {
    throw new Error(
      'Network binding blocked: without durable persistence and EVENTPILOT_ACCESS_KEY this build has no '
      + 'authentication or tenant isolation. Bind to 127.0.0.1/localhost/::1 only.'
    );
  }
  return { secure: loopback, persistence, host };
}

/**
 * Constant-time comparison so a wrong secret cannot be discovered by timing how
 * early the request is rejected.
 */
export function secretMatches(provided, expected) {
  const a = String(provided ?? ''), b = String(expected ?? '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse Cookie headers without a dependency. */
export function readCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}
