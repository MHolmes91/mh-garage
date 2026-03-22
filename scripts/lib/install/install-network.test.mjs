import assert from 'node:assert/strict';
import test from 'node:test';

test('detectPublicIp ignores non-ip bodies and returns the first IPv4 match', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    '<html>ifconfig response</html>',
    '198.51.100.10\n',
  ];

  globalThis.fetch = async () => ({
    async text() {
      return responses.shift() ?? '';
    },
  });

  try {
    const { detectPublicIp } = await import('./install-network.mjs');
    assert.equal(await detectPublicIp(), '198.51.100.10');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('detectPublicIp returns empty string when no IPv4 provider succeeds', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => ({
    async text() {
      return 'not-an-ip';
    },
  });

  try {
    const { detectPublicIp } = await import('./install-network.mjs');
    assert.equal(await detectPublicIp(), '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
