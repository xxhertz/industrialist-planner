import fs from "node:fs";
import path from "node:path";
import { createEmptyCatalog } from "./catalog";
import {
  Catalog,
  ResultChecklistKey,
  SerializedCatalog,
  SerializedChecklistCollection,
  SerializedChecklistEntry,
  SerializedRecipe,
  SerializedRecipeIngredient,
} from "./types";

function serializeIngredient(ingredient: { itemId: string; amount: string | bigint }): SerializedRecipeIngredient {
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
      showInPlanner: item.showInPlanner,
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
      showInPlanner: item.showInPlanner ?? true,
    })),
    recipes: serialized.recipes.map((recipe) => {
      const outputs = recipe.outputs ?? (recipe.output ? [recipe.output] : []);
      return {
        id: recipe.id,
        name: recipe.name,
        machineName: recipe.machineName,
        durationSec: recipe.durationSec,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.itemId,
          amount: input.amount,
        })),
        outputs: outputs.map((output) => ({
          itemId: output.itemId,
          amount: output.amount,
        })),
      };
    }),
  };
}

function createEmptyChecklistCollection(): SerializedChecklistCollection {
  return {
    entries: [],
  };
}

function ensureJsonFile<T>(filePath: string, defaultValue: T): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

export class CatalogStore {
  constructor(private readonly filePath: string) {}

  ensureFile(): void {
    ensureJsonFile(this.filePath, serializeCatalog(createEmptyCatalog()));
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

export class ChecklistStore {
  constructor(private readonly filePath: string) {}

  ensureFile(): void {
    ensureJsonFile(this.filePath, createEmptyChecklistCollection());
  }

  loadAll(): SerializedChecklistEntry[] {
    this.ensureFile();
    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as SerializedChecklistCollection;
    return parsed.entries ?? [];
  }

  load(resultKey: ResultChecklistKey): SerializedChecklistEntry | undefined {
    return this.loadAll().find((entry) => entry.resultKey === resultKey);
  }

  save(entry: SerializedChecklistEntry): void {
    const entries = this.loadAll().filter((candidate) => candidate.resultKey !== entry.resultKey);
    entries.push(entry);
    this.writeAll(entries);
  }

  remove(resultKey: ResultChecklistKey): void {
    const entries = this.loadAll().filter((entry) => entry.resultKey !== resultKey);
    this.writeAll(entries);
  }

  private writeAll(entries: SerializedChecklistEntry[]): void {
    this.ensureFile();
    fs.writeFileSync(this.filePath, JSON.stringify({ entries }, null, 2), "utf8");
  }
}

