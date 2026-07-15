const KEYCHAIN_PRICING = Object.freeze({
  2: 120,
  3: 150,
});

const DEFAULT_KEYCHAIN_COPIES = 3;

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
