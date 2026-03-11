export type ItemId = string;
export type RecipeId = string;

export interface Item {
  id: ItemId;
  name: string;
  aliases: string[];
}

export interface RecipeIngredient {
  itemId: ItemId;
  amount: bigint;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  machineName: string;
  durationSec: bigint;
  inputs: RecipeIngredient[];
  outputs: RecipeIngredient[];
}

export interface Catalog {
  schemaVersion: number;
  items: Item[];
  recipes: Recipe[];
}

export interface PlannerRequest {
  rootRecipeId: RecipeId;
  rootOutputItemId: ItemId;
  targetMode: "machineCount" | "outputPerSecond";
  targetValue: string;
  recipeSelections: Record<ItemId, RecipeId>;
}

export interface SerializedItem {
  id: ItemId;
  name: string;
  aliases: string[];
}

export interface SerializedRecipeIngredient {
  itemId: ItemId;
  amount: string;
}

export interface SerializedRecipe {
  id: RecipeId;
  name: string;
  machineName: string;
  durationSec: string;
  inputs: SerializedRecipeIngredient[];
  outputs?: SerializedRecipeIngredient[];
  output?: SerializedRecipeIngredient;
}

export interface SerializedCatalog {
  schemaVersion: number;
  items: SerializedItem[];
  recipes: SerializedRecipe[];
}
