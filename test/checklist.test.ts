import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChecklistEntry,
  buildChecklistItems,
  createChecklistResultKey,
} from "../src/core/checklist";
import { planFactory } from "../src/core/planner";
import { ChecklistStore } from "../src/core/storage";
import { Catalog } from "../src/core/types";

const steelCatalog: Catalog = {
  schemaVersion: 1,
  items: [
    { id: "coal", name: "Coal", aliases: ["coal"] },
    { id: "iron-ingot", name: "Iron Ingot", aliases: ["iron"] },
    { id: "steel", name: "Steel", aliases: ["steel"] },
    { id: "liquid-iron", name: "Liquid Iron", aliases: ["iron"] },
    { id: "raw-iron", name: "Raw Iron", aliases: ["iron"] },
  ],
  recipes: [
    {
      id: "steel",
      name: "Steel",
      machineName: "Blast Furnace",
      durationSec: 5n,
      inputs: [
        { itemId: "coal", amount: 4n },
        { itemId: "iron-ingot", amount: 1n },
      ],
      outputs: [{ itemId: "steel", amount: 2n }],
    },
    {
      id: "iron-ingot",
      name: "Iron Ingot",
      machineName: "Ingot Molder",
      durationSec: 4n,
      inputs: [{ itemId: "liquid-iron", amount: 4n }],
      outputs: [{ itemId: "iron-ingot", amount: 2n }],
    },
    {
      id: "liquid-iron",
      name: "Liquid Iron",
      machineName: "Electric Furnace",
      durationSec: 5n,
      inputs: [{ itemId: "raw-iron", amount: 1n }],
      outputs: [{ itemId: "liquid-iron", amount: 1n }],
    },
    {
      id: "raw-iron",
      name: "Raw Iron",
      machineName: "Iron Drill",
      durationSec: 15n,
      inputs: [],
      outputs: [{ itemId: "raw-iron", amount: 1n }],
    },
  ],
};

const tempDirectories: string[] = [];

function buildResult(targetValue: string) {
  return planFactory(steelCatalog, {
    rootRecipeId: "steel",
    rootOutputItemId: "steel",
    targetMode: "machineCount",
    targetValue,
    recipeSelections: {},
  });
}

function createTempChecklistStore() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "industrialist-checklist-"));
  tempDirectories.push(tempDirectory);
  return {
    filePath: path.join(tempDirectory, "checklists.json"),
    store: new ChecklistStore(path.join(tempDirectory, "checklists.json")),
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const tempDirectory = tempDirectories.pop();
    if (tempDirectory) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
});

describe("results checklist helpers", () => {
  it("creates a stable result key for identical plans and changes when the result changes", () => {
    const firstResult = buildResult("1");
    const secondResult = buildResult("1");
    const differentResult = buildResult("2");

    expect(createChecklistResultKey(firstResult)).toBe(createChecklistResultKey(secondResult));
    expect(createChecklistResultKey(firstResult)).not.toBe(
      createChecklistResultKey(differentResult),
    );
  });

  it("maps process rows to checklist labels and restores checked state by item id", () => {
    const result = buildResult("1");
    const initialItems = buildChecklistItems(result);
    const savedEntry = {
      resultKey: createChecklistResultKey(result),
      itemIds: [initialItems[0]!.id, "missing-item"],
      checkedItemIds: [initialItems[0]!.id, "missing-item"],
      updatedAt: "2026-03-11T00:00:00.000Z",
    };

    expect(initialItems.map((item) => item.label)).toEqual([
      "Build 5x Blast Furnace for steel",
      "Provide external coal at 4/s",
      "Build 2x Ingot Molder for iron",
      "Build 10x Electric Furnace for iron",
      "Build 30x Iron Drill for iron",
    ]);

    const restoredItems = buildChecklistItems(result, savedEntry);
    expect(restoredItems[0]?.checked).toBe(true);
    expect(restoredItems.slice(1).every((item) => !item.checked)).toBe(true);
  });
});

describe("checklist storage", () => {
  it("creates the file, saves entries, overwrites existing keys, and removes them", () => {
    const { filePath, store } = createTempChecklistStore();
    const result = buildResult("1");
    const resultKey = createChecklistResultKey(result);
    const items = buildChecklistItems(result).map((item, index) => ({
      ...item,
      checked: index < 2,
    }));

    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.loadAll()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true);

    const firstEntry = buildChecklistEntry(resultKey, items);
    store.save(firstEntry);
    expect(store.load(resultKey)).toEqual(firstEntry);

    const updatedEntry = {
      ...buildChecklistEntry(resultKey, items.map((item) => ({ ...item, checked: true }))),
      updatedAt: "2026-03-11T12:00:00.000Z",
    };
    store.save(updatedEntry);

    expect(store.loadAll()).toHaveLength(1);
    expect(store.load(resultKey)).toEqual(updatedEntry);

    store.remove(resultKey);
    expect(store.load(resultKey)).toBeUndefined();
    expect(store.loadAll()).toEqual([]);
  });
});
