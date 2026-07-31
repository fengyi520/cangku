import { DocumentType } from "@prisma/client";

export function piecesFromPackaging(cartons: number, piecesPerCarton: number, loosePieces: number) {
  if (![cartons, piecesPerCarton, loosePieces].every(Number.isInteger)) throw new Error("包装数量必须为整数");
  if (cartons < 0 || piecesPerCarton < 0 || loosePieces < 0) throw new Error("包装数量不能为负数");
  return cartons * piecesPerCarton + loosePieces;
}

export function quantityDeltaForDocument(input: {
  type: DocumentType;
  quantityPieces: number;
  snapshotQuantity?: number | null;
  countedPieces?: number | null;
  adjustmentDelta?: number | null;
}) {
  switch (input.type) {
    case "INBOUND":
    case "RETURN":
      return input.quantityPieces;
    case "OUTBOUND":
      return -input.quantityPieces;
    case "STOCKTAKE":
      if (input.snapshotQuantity == null || input.countedPieces == null) throw new Error("盘点行缺少快照或实盘数量");
      return input.countedPieces - input.snapshotQuantity;
    case "ADJUSTMENT":
    case "RESTORE":
      if (!input.adjustmentDelta) throw new Error("库存调整行缺少调整数量");
      return input.adjustmentDelta;
  }
}
