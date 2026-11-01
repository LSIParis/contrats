import { describe, expect, test } from 'vitest';
import { parseTrustProxy } from '../src/bootstrap.js';

describe('parseTrustProxy', () => {
  test.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['10.99.0.1', '10.99.0.1'],
    ['10.0.0.0/8,127.0.0.1', '10.0.0.0/8,127.0.0.1'],
  ])('%s -> %s', (value, expected) => {
    expect(parseTrustProxy(value)).toBe(expected);
  });

  test('refuse un nombre de sauts, que Fastify 5 ignorerait sans le signaler', () => {
    expect(() => parseTrustProxy('1')).toThrow(/TRUST_PROXY=1/);
  });
});
