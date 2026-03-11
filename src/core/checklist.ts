import {
  PlannerResult,
  ProcessRow,
} from "./planner";
import {
  ResultChecklistKey,
  SerializedChecklistEntry,
} from "./types";

export interface ResultChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}

export function createChecklistResultKey(result: PlannerResult): ResultChecklistKey {
  return JSON.stringify({
    rootRecipeId: result.rootRecipeId,
    rootOutputItemId: result.rootOutputItemId,
    scaleFactor: result.scaleFactor.toString(),
    processRows: result.processRows.map((row) =>
      row.kind === "machine"
        ? {
            kind: row.kind,
            recipeId: row.recipeId,
            itemId: row.itemId,
            scaledMachineCount: row.scaledMachineCount.toString(),
            byproductItemIds: row.byproducts.map((byproduct) => byproduct.itemId),
          }
        : {
            kind: row.kind,
            itemId: row.itemId,
            scaledRate: row.scaledRate.toFractionString(),
          },
    ),
  });
}

export function createChecklistItemId(row: ProcessRow): string {
  if (row.kind === "machine") {
    return [
      "machine",
      row.recipeId,
      row.itemId,
      row.scaledMachineCount.toString(),
      row.byproducts.map((byproduct) => byproduct.itemId).join(","),
    ].join(":");
  }

  return ["source", row.itemId, row.scaledRate.toFractionString()].join(":");
}

export function formatChecklistLabel(row: ProcessRow): string {
  if (row.kind === "machine") {
    return `Build ${row.scaledMachineCount.toString()}x ${row.machineName} for ${row.itemLabel}`;
  }

  return `Provide external ${row.itemLabel} at ${row.scaledRate.toDecimalString(4)}/s`;
}

export function buildChecklistItems(
  result: PlannerResult,
  savedEntry?: SerializedChecklistEntry,
): ResultChecklistItem[] {
  const checkedItemIds = new Set(savedEntry?.checkedItemIds ?? []);

  return result.processRows.map((row) => {
    const id = createChecklistItemId(row);
    return {
      id,
      label: formatChecklistLabel(row),
      checked: checkedItemIds.has(id),
    };
  });
}

export function buildChecklistEntry(
  resultKey: ResultChecklistKey,
  items: ResultChecklistItem[],
): SerializedChecklistEntry {
  return {
    resultKey,
    itemIds: items.map((item) => item.id),
    checkedItemIds: items.filter((item) => item.checked).map((item) => item.id),
    updatedAt: new Date().toISOString(),
  };
}
