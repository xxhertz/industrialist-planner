import { describe, expect, it } from "vitest";
import {
  CycleDetectedError,
  MissingRecipeSelectionError,
  planFactory,
  PlannerError,
} from "../src/core/planner";
import { getCompactItemLabel, validateCatalog } from "../src/core/catalog";
import { Catalog } from "../src/core/types";

const steelCatalog: Catalog = {
  schemaVersion: 1,
  items: [
    { id: "coal", name: "Coal", aliases: ["coal"] },
    { id: "iron-ingot", name: "Iron Ingot", aliases: ["iron"] },
    { id: "steel", name: "Steel", aliases: ["steel"] },
    { id: "liquid-iron", name: "Liquid Iron", aliases: ["iron"] },
    { id: "raw-iron", name: "Raw Iron", aliases: ["iron"] },
    { id: "steam", name: "Steam", aliases: ["steam"] },
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

describe("factory planner", () => {
  it("calculates the steel chain and scales to whole machines", () => {
    const result = planFactory(steelCatalog, {
      rootRecipeId: "steel",
      rootOutputItemId: "steel",
      targetMode: "machineCount",
      targetValue: "1",
      recipeSelections: {},
    });

    const counts = Object.fromEntries(
      result.recipeSummaries.map((summary) => [summary.recipeId, summary.scaledMachineCount]),
    );

    expect(result.scaleFactor).toBe(5n);
    expect(counts.steel).toBe(5n);
    expect(counts["iron-ingot"]).toBe(2n);
    expect(counts["liquid-iron"]).toBe(10n);
    expect(counts["raw-iron"]).toBe(30n);

    const coal = result.externalSources.find((source) => source.itemId === "coal");
    expect(coal?.scaledRate.toDecimalString(4)).toBe("4");
    expect(coal?.itemLabel).toBe("coal");
  });

  it("supports output-per-second planning for the selected root output", () => {
    const result = planFactory(steelCatalog, {
      rootRecipeId: "steel",
      rootOutputItemId: "steel",
      targetMode: "outputPerSecond",
      targetValue: "2",
      recipeSelections: {},
    });

    const steel = result.recipeSummaries.find((summary) => summary.recipeId === "steel");
    expect(steel?.scaledMachineCount).toBe(5n);
    expect(result.achievedOutputPerSecond.toDecimalString(4)).toBe("2");
  });

  it("builds process rows in dependency order with compact item labels", () => {
    const result = planFactory(steelCatalog, {
      rootRecipeId: "steel",
      rootOutputItemId: "steel",
      targetMode: "machineCount",
      targetValue: "1",
      recipeSelections: {},
    });

    expect(
      result.processRows.map((row) =>
        row.kind === "machine"
          ? `${row.machineName}:${row.itemLabel}`
          : `source:${row.itemLabel}`,
      ),
    ).toEqual([
      "Blast Furnace:steel",
      "source:coal",
      "Ingot Molder:iron",
      "Electric Furnace:iron",
      "Iron Drill:iron",
    ]);
  });

  it("tracks byproducts on multi-output recipes", () => {
    const byproductCatalog: Catalog = {
      ...steelCatalog,
      recipes: [
        {
          id: "steel-steam",
          name: "Steel With Steam",
          machineName: "Blast Furnace",
          durationSec: 5n,
          inputs: [
            { itemId: "coal", amount: 4n },
            { itemId: "iron-ingot", amount: 1n },
          ],
          outputs: [
            { itemId: "steel", amount: 2n },
            { itemId: "steam", amount: 1n },
          ],
        },
        ...steelCatalog.recipes.filter((recipe) => recipe.id !== "steel"),
      ],
    };

    const result = planFactory(byproductCatalog, {
      rootRecipeId: "steel-steam",
      rootOutputItemId: "steel",
      targetMode: "machineCount",
      targetValue: "1",
      recipeSelections: {},
    });

    const rootRow = result.processRows[0];
    expect(rootRow.kind).toBe("machine");
    if (rootRow.kind === "machine") {
      expect(rootRow.itemLabel).toBe("steel");
      expect(rootRow.byproducts.map((byproduct) => byproduct.itemLabel)).toEqual(["steam"]);
    }

    const rootSummary = result.recipeSummaries.find((summary) => summary.recipeId === "steel-steam");
    expect(rootSummary?.outputsPerSecond.map((output) => output.itemLabel)).toEqual(["steel", "steam"]);
  });

  it("allows machines with inputs and no outputs in the catalog", () => {
    const sinkCatalog: Catalog = {
      schemaVersion: 1,
      items: [{ id: "waste", name: "Waste", aliases: [] }],
      recipes: [
        {
          id: "void-waste",
          name: "Void Waste",
          machineName: "Trash Burner",
          durationSec: 1n,
          inputs: [{ itemId: "waste", amount: 1n }],
          outputs: [],
        },
      ],
    };

    expect(validateCatalog(sinkCatalog)).toEqual([]);
  });
  it("prefers the shortest alias and falls back to the item name", () => {
    const aliasCatalog: Catalog = {
      schemaVersion: 1,
      items: [
        { id: "a", name: "Long Name", aliases: ["long", "fe"] },
        { id: "b", name: "Fallback Name", aliases: [] },
      ],
      recipes: [],
    };

    expect(getCompactItemLabel(aliasCatalog, "a")).toBe("fe");
    expect(getCompactItemLabel(aliasCatalog, "b")).toBe("Fallback Name");
  });

  it("requires a selection when multiple recipes can produce an item", () => {
    const catalog: Catalog = {
      ...steelCatalog,
      recipes: [
        ...steelCatalog.recipes,
        {
          id: "alt-iron-ingot",
          name: "Alt Iron Ingot",
          machineName: "Alt Molder",
          durationSec: 2n,
          inputs: [{ itemId: "liquid-iron", amount: 2n }],
          outputs: [{ itemId: "iron-ingot", amount: 1n }],
        },
      ],
    };

    expect(() =>
      planFactory(catalog, {
        rootRecipeId: "steel",
        rootOutputItemId: "steel",
        targetMode: "machineCount",
        targetValue: "1",
        recipeSelections: {},
      }),
    ).toThrowError(MissingRecipeSelectionError);
  });

  it("detects cycles", () => {
    const cyclicCatalog: Catalog = {
      schemaVersion: 1,
      items: [
        { id: "a", name: "A", aliases: [] },
        { id: "b", name: "B", aliases: [] },
      ],
      recipes: [
        {
          id: "make-a",
          name: "Make A",
          machineName: "Assembler A",
          durationSec: 1n,
          inputs: [{ itemId: "b", amount: 1n }],
          outputs: [{ itemId: "a", amount: 1n }],
        },
        {
          id: "make-b",
          name: "Make B",
          machineName: "Assembler B",
          durationSec: 1n,
          inputs: [{ itemId: "a", amount: 1n }],
          outputs: [{ itemId: "b", amount: 1n }],
        },
      ],
    };

    expect(() =>
      planFactory(cyclicCatalog, {
        rootRecipeId: "make-a",
        rootOutputItemId: "a",
        targetMode: "machineCount",
        targetValue: "1",
        recipeSelections: {},
      }),
    ).toThrowError(CycleDetectedError);
  });

  it("rejects invalid recipe definitions", () => {
    const invalidCatalog: Catalog = {
      schemaVersion: 1,
      items: [{ id: "a", name: "A", aliases: [] }],
      recipes: [
        {
          id: "bad",
          name: "Bad Recipe",
          machineName: "Broken Machine",
          durationSec: 0n,
          inputs: [],
          outputs: [{ itemId: "a", amount: 1n }],
        },
      ],
    };

    expect(() =>
      planFactory(invalidCatalog, {
        rootRecipeId: "bad",
        rootOutputItemId: "a",
        targetMode: "machineCount",
        targetValue: "1",
        recipeSelections: {},
      }),
    ).toThrowError(PlannerError);
  });
});

