import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pricingConfig = require('../keychainPricing.config.json');
const {
  DEFAULT_KEYCHAIN_COPIES,
  KEYCHAIN_PRICING,
  getKeychainPrice,
  isValidKeychainCopies,
} = require('../keychainPricing.cjs');

test('shared keychain pricing config contains the official bundle prices', () => {
  assert.deepEqual(pricingConfig.keychainPricing, {
    2: 150,
    3: 199,
  });
  assert.equal(pricingConfig.defaultKeychainCopies, 3);
});

test('keychain pricing helper returns bundle prices, not per-keychain prices', () => {
  assert.equal(DEFAULT_KEYCHAIN_COPIES, 3);
  assert.deepEqual(KEYCHAIN_PRICING, {
    2: 150,
    3: 199,
  });
  assert.equal(isValidKeychainCopies(2), true);
  assert.equal(isValidKeychainCopies(3), true);
  assert.equal(getKeychainPrice(2), 150);
  assert.equal(getKeychainPrice(3), 199);
  assert.equal(getKeychainPrice(4), 0);
});

test('one 2-keychain sale and one 3-keychain sale total 349 pesos', () => {
  const total = getKeychainPrice(2) + getKeychainPrice(3);
  assert.equal(total, 349);
});
