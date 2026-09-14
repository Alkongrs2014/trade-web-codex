/* =====================================================================
   غلافٌ رقيق حول `stocks/indicators.js` و`stocks/score.js`.

   المنطق كلّه هناك لأن المتصفح يحتاجه ولا يستورد وحدات ES. هذا الملف
   يُبقي مستوردي ES على استيرادٍ واحد ولا يحوي حساباً واحداً — فلا موضع
   للتباعد أصلاً.
   ===================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const IND   = require("../../stocks/indicators.js");
const SCORE = require("../../stocks/score.js");

export const {
  sma, ema, rsi, macd, bb, atr, last, adx, adxLabel,
  pivots, divergence, bbWidth, pctRank, analyze, aggregate,
  obv, mfi, stoch, volumeProfile
} = IND;

export const {
  TFS, TF_LABEL, TF_WEIGHT, DEAD_ATR, scoreFrom, overallScore,
  BANDS, BAND_MARGIN, bandOf, bandStable, labelOf
} = SCORE;
