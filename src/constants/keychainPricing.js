import keychainPricingConfig from '../../keychainPricing.config.json';

export const KEYCHAIN_PRICING = Object.freeze(
  Object.fromEntries(
    Object.entries(keychainPricingConfig.keychainPricing || {})
      .map(([copies, price]) => [Number(copies), Number(price)])
      .filter(([copies, price]) => Number.isFinite(copies) && Number.isFinite(price) && price > 0),
  ),
);

export const DEFAULT_KEYCHAIN_COPIES = Number(keychainPricingConfig.defaultKeychainCopies) || 3;

export function isValidKeychainCopies(value) {
  const count = Number(value);
  return Object.prototype.hasOwnProperty.call(KEYCHAIN_PRICING, count);
}

export function getKeychainPrice(value) {
  const count = Number(value);
  return isValidKeychainCopies(count) ? KEYCHAIN_PRICING[count] : 0;
}
