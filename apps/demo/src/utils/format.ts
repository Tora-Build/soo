/**
 * Centralized formatting utilities for currency, percentages, and numbers.
 */

/**
 * Format a number as USD currency
 */
export const formatCurrency = (
    value: number,
    options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: options?.minimumFractionDigits ?? 2,
        maximumFractionDigits: options?.maximumFractionDigits ?? 2,
    }).format(value);
};

/**
 * Format a number as a percentage
 */
export const formatPercent = (value: number, decimals: number = 1): string => {
    return `${(value * 100).toFixed(decimals)}%`;
};

/**
 * Shorten an address for display
 */
export const shortenAddress = (address: string, chars: number = 4): string => {
    if (!address) return '';
    return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
};
