const PLATFORM_FEE_RATE = 0.04;
const PLATFORM_FEE_FIXED_JPY = 30;
const PLATFORM_FEE_DISPLAY = '4% + 30円';
const PLATFORM_FEE_DISPLAY_EN = '4% + ¥30';

function calculateRevenueSplit(grossAmount) {
  const normalizedGrossAmount = Number(grossAmount);
  if (!Number.isFinite(normalizedGrossAmount) || !Number.isInteger(normalizedGrossAmount) || normalizedGrossAmount < 0) {
    throw new Error('grossAmount must be a non-negative integer');
  }

  const platformFeeAmount = Math.floor(normalizedGrossAmount * PLATFORM_FEE_RATE) + PLATFORM_FEE_FIXED_JPY;
  const sellerAmount = normalizedGrossAmount - platformFeeAmount;

  return {
    grossAmount: normalizedGrossAmount,
    platformFeeAmount,
    sellerAmount
  };
}

module.exports = {
  PLATFORM_FEE_RATE,
  PLATFORM_FEE_FIXED_JPY,
  PLATFORM_FEE_DISPLAY,
  PLATFORM_FEE_DISPLAY_EN,
  calculateRevenueSplit,
};
