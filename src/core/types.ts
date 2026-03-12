export type ItemId = string;
export type RecipeId = string;
export type RecipeAmount = string | bigint;
export type RecipeDuration = string | bigint;

export interface Item {
  id: ItemId;
  name: string;
  aliases: string[];
  showInPlanner: boolean;
}

export interface RecipeIngredient {
  itemId: ItemId;
  amount: RecipeAmount;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  machineName: string;
  durationSec: RecipeDuration;
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
  rootOutputItemId?: ItemId;
  targetMode: "machineCount" | "outputPerSecond";
  targetValue: string;
  perRecipeCaps?: Record<RecipeId, string>;
  recipeSelections: Record<ItemId, RecipeId>;
}

export interface SerializedItem {
  id: ItemId;
  name: string;
  aliases: string[];
  showInPlanner?: boolean;
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

export type ResultChecklistKey = string;

export interface SerializedChecklistEntry {
  resultKey: ResultChecklistKey;
  itemIds: string[];
  checkedItemIds: string[];
  updatedAt: string;
}

export interface SerializedChecklistCollection {
  entries: SerializedChecklistEntry[];
}


