const pricingConfig = require('./keychainPricing.config.json');

const KEYCHAIN_PRICING = Object.freeze(
  Object.fromEntries(
    Object.entries(pricingConfig.keychainPricing || {})
      .map(([copies, price]) => [Number(copies), Number(price)])
      .filter(([copies, price]) => Number.isFinite(copies) && Number.isFinite(price) && price > 0),
  ),
);

const DEFAULT_KEYCHAIN_COPIES = Number(pricingConfig.defaultKeychainCopies) || 3;

function isValidKeychainCopies(value) {
  const count = Number(value);
  return Object.prototype.hasOwnProperty.call(KEYCHAIN_PRICING, count);
}

function getKeychainPrice(value) {
  const count = Number(value);
  return isValidKeychainCopies(count) ? KEYCHAIN_PRICING[count] : 0;
}

module.exports = {
  DEFAULT_KEYCHAIN_COPIES,
  KEYCHAIN_PRICING,
  getKeychainPrice,
  isValidKeychainCopies,
};
