export interface JantriCell {
  number: string; // "00" through "99"
  totalAmount: number;
  liability: number;
  isMaxRisk?: boolean;
}

export interface HarufCell {
  digit: string; // "0" through "9"
  andarAmount: number;
  baharAmount: number;
}

export interface JantriViewDto {
  shiftId: number;
  shiftName: string;
  shiftDate: string;
  totalCollected: number;
  totalRisk: number;
  grid: JantriCell[]; // 100 items (00-99)
  haruf: HarufCell[]; // 10 items (0-9)
}
