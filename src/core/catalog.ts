import { parseRecipeAmount } from "./amount";
import { Catalog, Item, ItemId, Recipe, RecipeId } from "./types";

export function createEmptyCatalog(): Catalog {
  return {
    schemaVersion: 1,
    items: [],
    recipes: [],
  };
}

export function makeStableId(name: string, existingIds: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "entry";

  const used = new Set(existingIds);
  if (!used.has(base)) {
    return base;
  }

  let counter = 2;
  while (used.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export function validateCatalog(catalog: Catalog): string[] {
  const errors: string[] = [];
  const itemIds = new Set<ItemId>();
  const recipeIds = new Set<RecipeId>();

  for (const item of catalog.items) {
    if (!item.name.trim()) {
      errors.push(`Item ${item.id} is missing a name.`);
    }
    if (itemIds.has(item.id)) {
      errors.push(`Duplicate item id: ${item.id}`);
    }
    itemIds.add(item.id);
  }

  for (const recipe of catalog.recipes) {
    if (!recipe.name.trim()) {
      errors.push(`Recipe ${recipe.id} is missing a name.`);
    }
    if (!recipe.machineName.trim()) {
      errors.push(`Recipe ${recipe.name} is missing a machine name.`);
    }
    if (recipeIds.has(recipe.id)) {
      errors.push(`Duplicate recipe id: ${recipe.id}`);
    }
    recipeIds.add(recipe.id);

    if (recipe.durationSec <= 0n) {
      errors.push(`Recipe ${recipe.name} must have a positive duration.`);
    }
    if (recipe.inputs.length === 0 && recipe.outputs.length === 0) {
      errors.push(`Recipe ${recipe.name} must have at least one input or output.`);
    }
    for (const output of recipe.outputs) {
      try {
        if (parseRecipeAmount(output.amount).compare(parseRecipeAmount(0n)) <= 0) {
          errors.push(`Recipe ${recipe.name} has a non-positive output amount.`);
        }
      } catch {
        errors.push(`Recipe ${recipe.name} has an invalid output amount.`);
      }
      if (!itemIds.has(output.itemId)) {
        errors.push(`Recipe ${recipe.name} output item does not exist.`);
      }
    }
    for (const input of recipe.inputs) {
      try {
        if (parseRecipeAmount(input.amount).compare(parseRecipeAmount(0n)) <= 0) {
          errors.push(`Recipe ${recipe.name} has a non-positive input amount.`);
        }
      } catch {
        errors.push(`Recipe ${recipe.name} has an invalid input amount.`);
      }
      if (!itemIds.has(input.itemId)) {
        errors.push(`Recipe ${recipe.name} input item does not exist.`);
      }
    }
  }

  return errors;
}

export function getItemById(catalog: Catalog, itemId: ItemId): Item | undefined {
  return catalog.items.find((item) => item.id === itemId);
}

export function getCompactItemLabel(catalog: Catalog, itemId: ItemId): string {
  const item = getItemById(catalog, itemId);
  if (!item) {
    return itemId;
  }

  const aliases = item.aliases.map((alias) => alias.trim()).filter(Boolean);
  if (aliases.length === 0) {
    return item.name;
  }

  return aliases.reduce((shortest, current) =>
    current.length < shortest.length ? current : shortest,
  );
}

export function getRecipeById(catalog: Catalog, recipeId: RecipeId): Recipe | undefined {
  return catalog.recipes.find((recipe) => recipe.id === recipeId);
}

export function getRecipeProducers(catalog: Catalog, itemId: ItemId): Recipe[] {
  return catalog.recipes.filter((recipe) =>
    recipe.outputs.some((output) => output.itemId === itemId),
  );
}

export function resolveItemByName(catalog: Catalog, raw: string): Item | undefined {
  const normalized = raw.trim().toLowerCase();
  return catalog.items.find((item) => {
    if (item.name.trim().toLowerCase() === normalized) {
      return true;
    }
    return item.aliases.some((alias) => alias.trim().toLowerCase() === normalized);
  });
}
