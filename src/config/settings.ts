export interface ScoreWeights {
  wTrendAboveMa50: number;
  wTrendMa50AboveMa200: number;
  wBreakout: number;
  wMa50Reclaim: number;
  wPullback: number;
  wMa50Pressure: number;
  wVixRegime: number;
  wVolumeConfirmation: number;
}

export interface ScannerSettings {
  minDollarVolume: number;
  minPrice: number;
  scoreWeights: ScoreWeights;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  wTrendAboveMa50: 20,
  wTrendMa50AboveMa200: 30,
  wBreakout: 50,
  wMa50Reclaim: 40,
  wPullback: 30,
  wMa50Pressure: 20,
  wVixRegime: 25,
  wVolumeConfirmation: 30,
};

export const SETTINGS: ScannerSettings = {
  minDollarVolume: 5_000_000,
  minPrice: 3,
  scoreWeights: DEFAULT_SCORE_WEIGHTS,
};
