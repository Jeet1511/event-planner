const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertSafeDeployment({ nodeEnv = 'development', host = '127.0.0.1' } = {}) {
  if (nodeEnv === 'production') {
    throw new Error(
      'Production startup blocked: this build still uses unauthenticated JSON-file persistence. ' +
      'Complete application authentication, PostgreSQL persistence, authorization integration tests and backup/restore verification first.'
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'Network binding blocked: the current JSON-file demo has no authentication or tenant isolation. ' +
      'Bind to 127.0.0.1/localhost/::1 only.'
    );
  }
}
