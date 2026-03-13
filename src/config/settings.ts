export interface ScannerSettings {
  minDollarVolume: number;
  minPrice: number;
}

export const SETTINGS: ScannerSettings = {
  minDollarVolume: 5_000_000,
  minPrice: 3,
};
