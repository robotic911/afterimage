export const KEYCHAIN_PRICING = Object.freeze({
  2: 120,
  3: 150,
});

export const DEFAULT_KEYCHAIN_COPIES = 3;

export function isValidKeychainCopies(value) {
  const count = Number(value);
  return Object.prototype.hasOwnProperty.call(KEYCHAIN_PRICING, count);
}

export function getKeychainPrice(value) {
  const count = Number(value);
  return isValidKeychainCopies(count) ? KEYCHAIN_PRICING[count] : 0;
}
