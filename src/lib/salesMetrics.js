import { getKeychainPrice, isValidKeychainCopies } from '../constants/keychainPricing';

export function getCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

export function getMoney(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

export function normalizeKeychainSaleCopies(value) {
  const count = Number(value);
  return isValidKeychainCopies(count) ? count : null;
}

export function getSessionKeychainSales(session = {}) {
  if (!Array.isArray(session?.keychainSales)) return [];
  return session.keychainSales
    .filter((sale) => sale && (!sale.printStatus || sale.printStatus === 'completed'))
    .map((sale) => {
      const copies = normalizeKeychainSaleCopies(sale.copies);
      if (!copies) return null;
      return {
        ...sale,
        copies,
        amount: getMoney(sale.amount, getKeychainPrice(copies)),
        createdAt: sale.createdAt || session.timestamp,
      };
    })
    .filter(Boolean);
}

export function getSessionKeychainUnitsSold(session = {}) {
  const explicit = Number(session?.keychainUnitsSold);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.floor(explicit));
  return getSessionKeychainSales(session).reduce((sum, sale) => sum + sale.copies, 0);
}

export function getSessionKeychainRevenue(session = {}) {
  const explicit = Number(session?.keychainRevenue);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, explicit);
  return getSessionKeychainSales(session).reduce((sum, sale) => sum + sale.amount, 0);
}

export function getSessionKeychainTransactions(session = {}) {
  const explicit = Number(session?.keychainSheetsPrinted ?? session?.keychainTransactions);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(0, Math.floor(explicit));
  return getSessionKeychainSales(session).length;
}

export function getSessionKeychainPrintCount(session = {}) {
  const transactions = getSessionKeychainTransactions(session);
  return transactions > 0 ? transactions : getCount(session?.keychainPrintCount, 0);
}

export function getSessionKeychainSummary(session = {}) {
  return {
    unitsSold: getSessionKeychainUnitsSold(session),
    revenue: getSessionKeychainRevenue(session),
    sheetsPrinted: getSessionKeychainTransactions(session),
    transactions: getSessionKeychainTransactions(session),
  };
}

export function getSessionTotalCopies(session = {}) {
  return getCount(
    session?.totalPrintCopies
      ?? session?.copies
      ?? session?.printCopiesCompleted,
    0,
  );
}

export function getSessionRevenue(session = {}) {
  return getMoney(session?.totalAmount, 0);
}

export function isRevenueEligibleSession(session = {}) {
  return session?.status !== 'failed';
}

export function getStripSessionRevenue(session = {}) {
  if (!isRevenueEligibleSession(session)) return 0;
  return getSessionRevenue(session);
}

export function getStripSessionRevenueTotal(sourceSessions = []) {
  return sourceSessions.reduce((sum, session) => sum + getStripSessionRevenue(session), 0);
}

export function getKeychainSalesForSessions(sourceSessions = []) {
  return sourceSessions
    .filter(isRevenueEligibleSession)
    .flatMap((session) => (
      getSessionKeychainSales(session).map((sale) => ({
        ...sale,
        sessionId: session.id,
        templateName: session.templateName || session.templateId || 'Unknown Template',
        layoutName: session.layoutName || session.layoutId || 'Unknown Layout',
      }))
    ));
}

export function getKeychainRevenueTotal(sourceSessions = []) {
  return getKeychainSalesForSessions(sourceSessions).reduce((sum, sale) => sum + sale.amount, 0);
}

export function getKeychainSummaryForSessions(sourceSessions = []) {
  const sales = getKeychainSalesForSessions(sourceSessions);
  return {
    unitsSold: sales.reduce((sum, sale) => sum + sale.copies, 0),
    revenue: sales.reduce((sum, sale) => sum + sale.amount, 0),
    sheetsPrinted: sales.length,
    transactions: sales.length,
    sales,
  };
}

export function getTotalRevenue(sourceSessions = []) {
  return getStripSessionRevenueTotal(sourceSessions) + getKeychainRevenueTotal(sourceSessions);
}
