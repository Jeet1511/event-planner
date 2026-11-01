import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeDeployment } from '../src/deployment.mjs';

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
  assert.throws(() => assertSafeDeployment({ nodeEnv: 'production', host: '127.0.0.1' }), /Production startup blocked/);
});
