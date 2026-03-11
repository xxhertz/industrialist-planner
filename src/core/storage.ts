import fs from "node:fs";
import path from "node:path";
import { createEmptyCatalog } from "./catalog";
import {
  Catalog,
  SerializedCatalog,
  SerializedRecipe,
  SerializedRecipeIngredient,
} from "./types";

function serializeIngredient(ingredient: { itemId: string; amount: bigint }): SerializedRecipeIngredient {
  return {
    itemId: ingredient.itemId,
    amount: ingredient.amount.toString(),
  };
}

function serializeRecipe(recipe: Catalog["recipes"][number]): SerializedRecipe {
  return {
    id: recipe.id,
    name: recipe.name,
    machineName: recipe.machineName,
    durationSec: recipe.durationSec.toString(),
    inputs: recipe.inputs.map(serializeIngredient),
    outputs: recipe.outputs.map(serializeIngredient),
  };
}

export function serializeCatalog(catalog: Catalog): SerializedCatalog {
  return {
    schemaVersion: catalog.schemaVersion,
    items: catalog.items.map((item) => ({
      id: item.id,
      name: item.name,
      aliases: [...item.aliases],
    })),
    recipes: catalog.recipes.map(serializeRecipe),
  };
}

export function deserializeCatalog(serialized: SerializedCatalog): Catalog {
  return {
    schemaVersion: serialized.schemaVersion,
    items: serialized.items.map((item) => ({
      id: item.id,
      name: item.name,
      aliases: [...item.aliases],
    })),
    recipes: serialized.recipes.map((recipe) => {
      const outputs = recipe.outputs ?? (recipe.output ? [recipe.output] : []);
      return {
        id: recipe.id,
        name: recipe.name,
        machineName: recipe.machineName,
        durationSec: BigInt(recipe.durationSec),
        inputs: recipe.inputs.map((input) => ({
          itemId: input.itemId,
          amount: BigInt(input.amount),
        })),
        outputs: outputs.map((output) => ({
          itemId: output.itemId,
          amount: BigInt(output.amount),
        })),
      };
    }),
  };
}

export class CatalogStore {
  constructor(private readonly filePath: string) {}

  ensureFile(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(serializeCatalog(createEmptyCatalog()), null, 2),
        "utf8",
      );
    }
  }

  load(): Catalog {
    this.ensureFile();
    const raw = fs.readFileSync(this.filePath, "utf8");
    return deserializeCatalog(JSON.parse(raw) as SerializedCatalog);
  }

  save(catalog: Catalog): void {
    this.ensureFile();
    fs.writeFileSync(this.filePath, JSON.stringify(serializeCatalog(catalog), null, 2), "utf8");
  }
}
