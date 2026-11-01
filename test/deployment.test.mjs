import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeDeployment, readCookies, secretMatches } from '../src/deployment.mjs';

const KEY = 'workspace-secret-value-1234';

test('local demo may bind only to loopback', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.doesNotThrow(() => assertSafeDeployment({ nodeEnv: 'development', host }));
  }
});

test('network interfaces are rejected while authentication is absent', () => {
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertSafeDeployment({ nodeEnv: 'development', host }), /Network binding blocked/);
  }
});

test('production startup is fail-closed until the secure backend is implemented', () => {
  // assert.throws returns nothing, so capture the error to read its message.
  let error;
  try { assertSafeDeployment({ nodeEnv: 'production', host: '127.0.0.1' }); } catch (caught) { error = caught; }
  assert.ok(error, 'production startup must refuse');
  assert.match(error.message, /Production startup blocked/);
  // The refusal must name what is missing, or an operator has to guess.
  assert.match(error.message, /durable persistence/);
  assert.match(error.message, /EVENTPILOT_ACCESS_KEY/);
});

test('a short access key does not count as configured', () => {
  assert.throws(
    () => assertSafeDeployment({ nodeEnv: 'production', host: '0.0.0.0', persistence: 'supabase', accessKey: 'tooshort' }),
    /EVENTPILOT_ACCESS_KEY/
  );
});

test('production is allowed once persistence and a workspace secret are both configured', () => {
  const decision = assertSafeDeployment({ nodeEnv: 'production', host: '0.0.0.0', persistence: 'supabase', accessKey: KEY });
  assert.equal(decision.secure, true);
  assert.equal(decision.persistence, 'supabase');
});

test('durable storage alone still will not open the network', () => {
  assert.throws(
    () => assertSafeDeployment({ nodeEnv: 'development', host: '0.0.0.0', persistence: 'supabase', accessKey: '' }),
    /Network binding blocked/
  );
});

test('a keyed deployment may bind a network interface', () => {
  const decision = assertSafeDeployment({ nodeEnv: 'development', host: '0.0.0.0', persistence: 'supabase', accessKey: KEY });
  assert.equal(decision.secure, false, 'development on a public interface is usable but not called secure');
});

test('key comparison is length-safe and does not accept a prefix', () => {
  assert.equal(secretMatches(KEY, KEY), true);
  assert.equal(secretMatches(KEY.slice(0, 10), KEY), false);
  assert.equal(secretMatches(`${KEY}x`, KEY), false);
  assert.equal(secretMatches(undefined, KEY), false);
  assert.equal(secretMatches('', ''), true);
});

test('cookies are parsed without a dependency', () => {
  assert.deepEqual(readCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(readCookies(''), {});
  assert.deepEqual(readCookies('broken'), {});
  assert.deepEqual(readCookies('eventpilot_session=deadbeef.deadbeef%20trailing').eventpilot_session.startsWith('deadbeef.'), true);
});
