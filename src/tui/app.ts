import blessed from "blessed";
import type { Widgets } from "blessed";
import path from "node:path";
import {
  buildChecklistEntry,
  buildChecklistItems,
  createChecklistResultKey,
} from "../core/checklist";
import {
  createEmptyCatalog,
  getCompactItemLabel,
  getItemById,
  getRecipeById,
  makeStableId,
  resolveItemByName,
  validateCatalog,
} from "../core/catalog";
import {
  formatRate,
  MissingRecipeSelectionError,
  planFactory,
  PlannerError,
  PlannerResult,
  ProcessMachineRow,
} from "../core/planner";
import { CatalogStore, ChecklistStore } from "../core/storage";
import { Catalog, Item, PlannerRequest, Recipe, RecipeIngredient } from "../core/types";

type KeyBinding = {
  keys: string[];
  listener: () => void;
};

type CatalogTab = "items" | "recipes";

type PlannerChoice = {
  recipeId: string;
  outputItemId: string;
  label: string;
};

export class IndustrialistApp {
  private readonly screen = blessed.screen({
    smartCSR: true,
    title: "Industrialist Planner",
    fullUnicode: true,
  });

  private readonly header = blessed.box({
    parent: this.screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    tags: true,
  });

  private readonly body = blessed.box({
    parent: this.screen,
    top: 3,
    left: 0,
    width: "100%",
    height: "100%-6",
    border: "line",
    tags: true,
  });

  private readonly footer = blessed.box({
    parent: this.screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    tags: true,
  });

  private readonly bindings: KeyBinding[] = [];
  private catalog: Catalog = createEmptyCatalog();
  private currentTab: CatalogTab = "items";
  private lastResult: PlannerResult | null = null;
  private catalogSelection = {
    items: 0,
    recipes: 0,
  };

  constructor(
    private readonly catalogStore: CatalogStore,
    private readonly checklistStore: ChecklistStore,
  ) {}

  async start(): Promise<void> {
    this.catalog = this.catalogStore.load();
    this.screen.key(["C-c"], () => {
      this.screen.destroy();
      process.exit(0);
    });
    this.showHome();
  }

  private clearViewBindings(): void {
    while (this.bindings.length > 0) {
      const binding = this.bindings.pop();
      if (binding) {
        for (const key of binding.keys) {
          this.screen.unkey(key, binding.listener);
        }
      }
    }
  }

  private bindViewKey(keys: string[], handler: () => void | Promise<void>): void {
    const listener = () => {
      void handler();
    };
    this.bindings.push({ keys, listener });
    this.screen.key(keys, listener);
  }

  private setChrome(title: string, help: string): void {
    this.header.setContent(` {bold}${title}{/bold} `);
    this.footer.setContent(` ${help} `);
  }

  private clearBody(): void {
    this.body.children.slice().forEach((child: Widgets.Node) => child.destroy());
  }

  private async promptInput(label: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const prompt = blessed.prompt({
        parent: this.screen,
        border: "line",
        width: "70%",
        height: 9,
        top: "center",
        left: "center",
        label: ` ${label} `,
      });
      prompt.input(label, initial, (_error: unknown, value: string | null) => {
        prompt.destroy();
        this.screen.render();
        resolve(value === null ? null : value.trim());
      });
      this.screen.render();
    });
  }

  private async promptChoice(title: string, items: string[]): Promise<number | null> {
    return new Promise((resolve) => {
      const wrapper = blessed.box({
        parent: this.screen,
        border: "line",
        width: "70%",
        height: Math.min(items.length + 4, 20),
        top: "center",
        left: "center",
        label: ` ${title} `,
      });

      const list = blessed.list({
        parent: wrapper,
        top: 0,
        left: 0,
        width: "100%-2",
        height: "100%-2",
        keys: true,
        vi: true,
        mouse: true,
        items,
        style: {
          selected: {
            bg: "blue",
          },
        },
      });

      const finish = (value: number | null) => {
        wrapper.destroy();
        this.screen.render();
        resolve(value);
      };

      list.on("select", (_item: Widgets.BlessedElement, index: number) => finish(index));
      list.key(["escape", "q"], () => finish(null));
      list.focus();
      this.screen.render();
    });
  }

  private async confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const question = blessed.question({
        parent: this.screen,
        border: "line",
        width: "70%",
        height: 7,
        top: "center",
        left: "center",
        label: " Confirm ",
      });
      question.ask(message, (answer: boolean) => {
        question.destroy();
        this.screen.render();
        resolve(answer);
      });
      this.screen.render();
    });
  }

  private async showMessage(title: string, message: string): Promise<void> {
    return new Promise((resolve) => {
      const box = blessed.message({
        parent: this.screen,
        border: "line",
        width: "75%",
        height: 9,
        top: "center",
        left: "center",
        label: ` ${title} `,
      });
      box.display(message, 0, () => {
        box.destroy();
        this.screen.render();
        resolve();
      });
      this.screen.render();
    });
  }

  private showHome(): void {
    this.clearViewBindings();
    this.clearBody();
    this.setChrome(
      "Industrialist Planner",
      "Enter select  q quit  c catalog  p planner  r results",
    );

    blessed.box({
      parent: this.body,
      top: 1,
      left: 2,
      width: "100%-4",
      height: 5,
      tags: true,
      content:
        "Define named items and recipes, then calculate the smallest whole-machine chain needed to run at full efficiency.",
    });

    const menu = blessed.list({
      parent: this.body,
      top: 7,
      left: 2,
      width: "60%",
      height: 8,
      border: "line",
      keys: true,
      vi: true,
      mouse: true,
      items: ["Catalog", "Planner", "Results", "Quit"],
      style: {
        selected: {
          bg: "blue",
        },
      },
    });

    menu.on("select", (_item: Widgets.BlessedElement, index: number) => {
      if (index === 0) {
        this.showCatalog();
      } else if (index === 1) {
        this.showPlannerView();
      } else if (index === 2) {
        if (this.lastResult) {
          this.showResults(this.lastResult);
        } else {
          void this.showMessage("No Results", "Run a planner calculation first.");
        }
      } else {
        this.screen.destroy();
        process.exit(0);
      }
    });

    this.bindViewKey(["q"], () => {
      this.screen.destroy();
      process.exit(0);
    });
    this.bindViewKey(["c"], () => this.showCatalog());
    this.bindViewKey(["p"], () => this.showPlannerView());
    this.bindViewKey(["r"], async () => {
      if (this.lastResult) {
        this.showResults(this.lastResult);
      } else {
        await this.showMessage("No Results", "Run a planner calculation first.");
      }
    });

    menu.focus();
    this.screen.render();
  }

  private showCatalog(): void {
    this.clearViewBindings();
    this.clearBody();
    this.setChrome(
      `Catalog: ${this.currentTab}`,
      "Tab switch  a add  e edit  d delete  p planner  q home",
    );

    const errors = validateCatalog(this.catalog);
    blessed.box({
      parent: this.body,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      content:
        errors.length > 0
          ? `{red-fg}${errors[0]}{/red-fg}`
          : `{green-fg}${this.catalog.items.length} items, ${this.catalog.recipes.length} recipes{/green-fg}`,
    });

    const table = blessed.listtable({
      parent: this.body,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-3",
      border: "line",
      keys: true,
      vi: true,
      mouse: true,
      style: {
        header: {
          fg: "yellow",
          bold: true,
        },
        cell: {
          selected: {
            bg: "blue",
          },
        },
      },
    });

    const render = () => {
      if (this.currentTab === "items") {
        table.setData([
          ["Name", "Aliases", "Id"],
          ...this.catalog.items.map((item) => [item.name, item.aliases.join(", "), item.id]),
        ]);
      } else {
        table.setData([
          ["Recipe", "Machine", "Outputs", "Duration", "Inputs"],
          ...this.catalog.recipes.map((recipe) => [
            recipe.name,
            recipe.machineName,
            recipe.outputs
              .map(
                (output) =>
                  `${getItemById(this.catalog, output.itemId)?.name ?? output.itemId} x${output.amount.toString()}`,
              )
              .join(", "),
            `${recipe.durationSec.toString()}s`,
            recipe.inputs
              .map(
                (input) =>
                  `${getItemById(this.catalog, input.itemId)?.name ?? input.itemId} x${input.amount.toString()}`,
              )
              .join(", "),
          ]),
        ]);
      }
      this.screen.render();
    };

    const getRowsForCurrentTab = () =>
      this.currentTab === "items" ? this.catalog.items : this.catalog.recipes;

    const getSelectedIndex = () => {
      const rows = getRowsForCurrentTab();
      if (rows.length === 0) {
        return -1;
      }
      const storedIndex =
        this.currentTab === "items"
          ? this.catalogSelection.items
          : this.catalogSelection.recipes;
      return Math.max(0, Math.min(storedIndex, rows.length - 1));
    };

    const setSelection = (index: number) => {
      const currentIndex = Math.max(index, 0);
      if (this.currentTab === "items") {
        this.catalogSelection.items = currentIndex;
      } else {
        this.catalogSelection.recipes = currentIndex;
      }
    };

    const syncTableSelection = () => {
      if (getSelectedIndex() >= 0) {
        table.select(getSelectedIndex() + 1);
      }
    };

    this.bindViewKey(["tab"], () => {
      this.currentTab = this.currentTab === "items" ? "recipes" : "items";
      this.showCatalog();
    });
    this.bindViewKey(["q"], () => this.showHome());
    this.bindViewKey(["p"], () => this.showPlannerView());
    this.bindViewKey(["a"], async () => {
      if (this.currentTab === "items") {
        await this.addItem();
      } else {
        await this.addRecipe();
      }
      render();
      syncTableSelection();
    });
    this.bindViewKey(["e"], async () => {
      if (this.currentTab === "items") {
        const item = this.catalog.items[getSelectedIndex()];
        if (item) {
          await this.editItem(item);
        }
      } else {
        const recipe = this.catalog.recipes[getSelectedIndex()];
        if (recipe) {
          await this.editRecipe(recipe);
        }
      }
      render();
      syncTableSelection();
    });
    this.bindViewKey(["d"], async () => {
      if (this.currentTab === "items") {
        const item = this.catalog.items[getSelectedIndex()];
        if (item) {
          await this.deleteItem(item);
        }
      } else {
        const recipe = this.catalog.recipes[getSelectedIndex()];
        if (recipe) {
          await this.deleteRecipe(recipe);
        }
      }
      render();
      syncTableSelection();
    });
    table.key(["enter"], async () => {
      if (this.currentTab === "items") {
        const item = this.catalog.items[getSelectedIndex()];
        if (item) {
          await this.editItem(item);
        }
      } else {
        const recipe = this.catalog.recipes[getSelectedIndex()];
        if (recipe) {
          await this.editRecipe(recipe);
        }
      }
      render();
      syncTableSelection();
    });

    table.on("select", (_item: Widgets.BlessedElement, index: number) => {
      setSelection(index - 1);
    });

    render();
    syncTableSelection();
    table.focus();
  }

  private getPlannerChoices(): PlannerChoice[] {
    return this.catalog.recipes.flatMap((recipe) =>
      recipe.outputs.map((output) => ({
        recipeId: recipe.id,
        outputItemId: output.itemId,
        label: `${getCompactItemLabel(this.catalog, output.itemId)} via ${recipe.name}`,
      })),
    );
  }

  private showPlannerView(): void {
    this.clearViewBindings();
    this.clearBody();
    this.setChrome("Planner Setup", "Enter or p run plan  q home");

    blessed.box({
      parent: this.body,
      top: 1,
      left: 2,
      width: "100%-4",
      height: 4,
      content:
        "Select the output you want to plan around. The wizard will ask for either machine count or target output per second, then resolve alternative upstream recipes if needed.",
    });

    const plannerChoices = this.getPlannerChoices();
    const list = blessed.list({
      parent: this.body,
      top: 6,
      left: 2,
      width: "80%",
      height: "100%-8",
      border: "line",
      keys: true,
      vi: true,
      mouse: true,
      items: plannerChoices.map((choice) => choice.label),
      style: {
        selected: {
          bg: "blue",
        },
      },
    });

    const run = async () => {
      const choice = plannerChoices[(list as unknown as { selected: number }).selected ?? 0];
      if (!choice) {
        return;
      }
      const recipe = getRecipeById(this.catalog, choice.recipeId);
      if (!recipe) {
        return;
      }
      await this.runPlannerWizard(recipe, choice.outputItemId);
    };

    this.bindViewKey(["q"], () => this.showHome());
    this.bindViewKey(["p"], run);
    list.key(["enter"], () => {
      void run();
    });
    list.focus();
    this.screen.render();
  }

  private async runPlannerWizard(rootRecipe: Recipe, rootOutputItemId: string): Promise<void> {
    const targetModeIndex = await this.promptChoice("Target mode", [
      "Machine count",
      "Output per second",
    ]);
    if (targetModeIndex === null) {
      this.showPlannerView();
      return;
    }

    const targetMode = targetModeIndex === 0 ? "machineCount" : "outputPerSecond";
    const targetValue = await this.promptInput(
      targetMode === "machineCount" ? "Desired machine count" : "Desired output per second",
      "1",
    );
    if (!targetValue) {
      this.showPlannerView();
      return;
    }

    const request: PlannerRequest = {
      rootRecipeId: rootRecipe.id,
      rootOutputItemId,
      targetMode,
      targetValue,
      recipeSelections: {},
    };

    while (true) {
      try {
        const result = planFactory(this.catalog, request);
        this.lastResult = result;
        this.showResults(result);
        return;
      } catch (error) {
        if (error instanceof MissingRecipeSelectionError) {
          const item = getItemById(this.catalog, error.itemId);
          const index = await this.promptChoice(
            `Select producer for ${item?.name ?? error.itemId}`,
            error.producerRecipeIds.map((recipeId) => {
              const recipe = getRecipeById(this.catalog, recipeId);
              return `${recipe?.name ?? recipeId} (${recipe?.machineName ?? "machine"})`;
            }),
          );
          if (index === null) {
            this.showPlannerView();
            return;
          }
          request.recipeSelections[error.itemId] = error.producerRecipeIds[index];
          continue;
        }

        const message =
          error instanceof PlannerError ? error.message : "Unexpected planner failure.";
        await this.showMessage("Planner Error", message);
        this.showPlannerView();
        return;
      }
    }
  }

  private showResults(result: PlannerResult): void {
    this.clearViewBindings();
    this.clearBody();
    this.setChrome(
      "Results",
      "up/down move  space/enter toggle  a all  x clear  p planner  q home",
    );

    const resultKey = createChecklistResultKey(result);
    let checklistItems = buildChecklistItems(result, this.checklistStore.load(resultKey));
    const rootRecipe = getRecipeById(this.catalog, result.rootRecipeId);
    blessed.box({
      parent: this.body,
      top: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      content:
        `{bold}${rootRecipe?.name ?? result.rootRecipeId}{/bold} for {bold}${result.rootOutputItemLabel}{/bold}\n` +
        `Scale factor: ${result.scaleFactor.toString()}\n` +
        `Achieved output: ${formatRate(result.achievedOutputPerSecond)}`,
    });

    blessed.listtable({
      parent: this.body,
      top: 4,
      left: 0,
      width: "60%",
      height: "50%-2",
      border: "line",
      label: " Process Order ",
      data: [
        ["Machine", "Item", "Exact", "Scaled", "Rate/sec"],
        ...result.processRows.map((row) =>
          row.kind === "machine"
            ? [
                row.machineName,
                this.formatProcessItem(row),
                row.exactMachineCount.toFractionString(),
                row.scaledMachineCount.toString(),
                row.outputPerSecond.toDecimalString(4),
              ]
            : [
                "",
                row.itemLabel,
                row.exactRate.toFractionString(),
                row.scaledRate.toDecimalString(4),
                "external",
              ],
        ),
      ],
      style: {
        header: {
          fg: "yellow",
          bold: true,
        },
      },
    });

    blessed.listtable({
      parent: this.body,
      top: 4,
      left: "60%",
      width: "40%",
      height: "50%-2",
      border: "line",
      label: " External Sources ",
      data: [
        ["Item", "Exact/sec", "Scaled/sec"],
        ...result.externalSources.map((source) => [
          source.itemLabel,
          source.exactRate.toFractionString(),
          source.scaledRate.toDecimalString(4),
        ]),
      ],
      style: {
        header: {
          fg: "yellow",
          bold: true,
        },
      },
    });

    const checklist = blessed.list({
      parent: this.body,
      top: "50%+2",
      left: 0,
      width: "42%",
      height: "50%-2",
      border: "line",
      label: " Checklist ",
      keys: true,
      vi: true,
      mouse: true,
      style: {
        selected: {
          bg: "blue",
        },
      },
    });

    blessed.box({
      parent: this.body,
      top: "50%+2",
      left: "42%",
      width: "58%",
      height: "50%-2",
      border: "line",
      label: " Dependency Tree ",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      content: this.renderDependencyTree(result),
    });

    const getSelectedChecklistIndex = () =>
      Math.max(
        0,
        Math.min(
          (checklist as unknown as { selected?: number }).selected ?? 0,
          Math.max(checklistItems.length - 1, 0),
        ),
      );

    const persistChecklist = () => {
      if (checklistItems.every((item) => !item.checked)) {
        this.checklistStore.remove(resultKey);
        return;
      }

      this.checklistStore.save(buildChecklistEntry(resultKey, checklistItems));
    };

    const renderChecklist = () => {
      const completedCount = checklistItems.filter((item) => item.checked).length;
      checklist.setLabel(` Checklist ${completedCount}/${checklistItems.length} `);
      checklist.setItems(
        checklistItems.map((item) => `${item.checked ? "[x]" : "[ ]"} ${item.label}`),
      );
      if (checklistItems.length > 0) {
        checklist.select(getSelectedChecklistIndex());
      }
      this.screen.render();
    };

    const toggleSelectedChecklistItem = () => {
      if (checklistItems.length === 0) {
        return;
      }

      const selectedIndex = getSelectedChecklistIndex();
      checklistItems = checklistItems.map((item, index) =>
        index === selectedIndex ? { ...item, checked: !item.checked } : item,
      );
      persistChecklist();
      renderChecklist();
      checklist.focus();
    };

    const setAllChecklistItems = (checked: boolean) => {
      if (checklistItems.length === 0) {
        return;
      }

      checklistItems = checklistItems.map((item) => ({ ...item, checked }));
      persistChecklist();
      renderChecklist();
      checklist.focus();
    };

    this.bindViewKey(["q"], () => this.showHome());
    this.bindViewKey(["p"], () => this.showPlannerView());
    this.bindViewKey(["space", "enter"], () => toggleSelectedChecklistItem());
    this.bindViewKey(["a"], () => setAllChecklistItems(true));
    this.bindViewKey(["x"], () => setAllChecklistItems(false));

    renderChecklist();
    checklist.focus();
  }

  private formatProcessItem(row: ProcessMachineRow): string {
    if (row.byproducts.length === 0) {
      return row.itemLabel;
    }
    return `${row.itemLabel} (+${row.byproducts.map((byproduct) => byproduct.itemLabel).join(", ")})`;
  }

  private renderDependencyTree(result: PlannerResult): string {
    const lines: string[] = [];
    const visited = new Set<string>();

    const visit = (recipeId: string, depth: number, displayItemId: string) => {
      const recipe = getRecipeById(this.catalog, recipeId);
      const summary = result.recipeSummaries.find((entry) => entry.recipeId === recipeId);
      if (!recipe || !summary) {
        return;
      }

      const output =
        summary.outputsPerSecond.find((entry) => entry.itemId === displayItemId) ??
        summary.outputsPerSecond[0];
      const byproducts = summary.outputsPerSecond
        .filter((entry) => entry.itemId !== output.itemId)
        .map((entry) => entry.itemLabel);

      const indent = "  ".repeat(depth);
      lines.push(
        `${indent}${recipe.machineName} [${output.itemLabel}${byproducts.length > 0 ? ` + ${byproducts.join(", ")}` : ""}] x${summary.scaledMachineCount.toString()}`,
      );

      for (const edge of result.dependencyGraph[recipeId] ?? []) {
        const itemIndent = "  ".repeat(depth + 1);
        if (!edge.producerRecipeId) {
          const external = result.externalSources.find((source) => source.itemId === edge.itemId);
          lines.push(
            `${itemIndent}${getCompactItemLabel(this.catalog, edge.itemId)}: external ${
              external ? external.scaledRate.toDecimalString(4) : "0"
            }/s`,
          );
          continue;
        }

        lines.push(`${itemIndent}${getCompactItemLabel(this.catalog, edge.itemId)}`);
        const key = `${recipeId}->${edge.producerRecipeId}:${edge.itemId}`;
        if (!visited.has(key)) {
          visited.add(key);
          visit(edge.producerRecipeId, depth + 2, edge.itemId);
        }
      }
    };

    visit(result.rootRecipeId, 0, result.rootOutputItemId);
    return lines.join("\n");
  }

  private async addItem(): Promise<void> {
    const name = await this.promptInput("Item name");
    if (!name) {
      return;
    }
    const aliasesInput = await this.promptInput("Aliases (comma-separated)", "");
    if (aliasesInput === null) {
      return;
    }

    this.catalog.items.push({
      id: makeStableId(name, this.catalog.items.map((item) => item.id)),
      name,
      aliases: parseAliases(aliasesInput),
    });
    this.persistCatalog();
  }

  private async editItem(item: Item): Promise<void> {
    const name = await this.promptInput("Item name", item.name);
    if (!name) {
      return;
    }
    const aliasesInput = await this.promptInput(
      "Aliases (comma-separated)",
      item.aliases.join(", "),
    );
    if (aliasesInput === null) {
      return;
    }

    item.name = name;
    item.aliases = parseAliases(aliasesInput);
    this.persistCatalog();
  }

  private async deleteItem(item: Item): Promise<void> {
    const used = this.catalog.recipes.some(
      (recipe) =>
        recipe.outputs.some((output) => output.itemId === item.id) ||
        recipe.inputs.some((input) => input.itemId === item.id),
    );
    if (used) {
      await this.showMessage("Cannot Delete", "This item is still used by one or more recipes.");
      return;
    }
    if (!(await this.confirm(`Delete item "${item.name}"?`))) {
      return;
    }
    this.catalog.items = this.catalog.items.filter((entry) => entry.id !== item.id);
    this.persistCatalog();
  }

  private async addRecipe(): Promise<void> {
    if (this.catalog.items.length === 0) {
      await this.showMessage("No Items", "Create items first so recipe ingredients can reference them.");
      return;
    }

    const fields = await this.collectRecipeFields();
    if (!fields) {
      return;
    }

    this.catalog.recipes.push({
      id: makeStableId(fields.name, this.catalog.recipes.map((recipe) => recipe.id)),
      ...fields,
    });
    this.persistCatalog();
  }

  private async editRecipe(recipe: Recipe): Promise<void> {
    const fields = await this.collectRecipeFields(recipe);
    if (!fields) {
      return;
    }

    recipe.name = fields.name;
    recipe.machineName = fields.machineName;
    recipe.durationSec = fields.durationSec;
    recipe.inputs = fields.inputs;
    recipe.outputs = fields.outputs;
    this.persistCatalog();
  }

  private async deleteRecipe(recipe: Recipe): Promise<void> {
    if (!(await this.confirm(`Delete recipe "${recipe.name}"?`))) {
      return;
    }
    this.catalog.recipes = this.catalog.recipes.filter((entry) => entry.id !== recipe.id);
    this.persistCatalog();
  }

  private async collectRecipeFields(existing?: Recipe): Promise<Omit<Recipe, "id"> | null> {
    const name = await this.promptInput("Recipe name", existing?.name ?? "");
    if (!name) {
      return null;
    }
    const machineName = await this.promptInput("Machine name", existing?.machineName ?? "");
    if (!machineName) {
      return null;
    }
    const durationRaw = await this.promptInput(
      "Duration in seconds",
      existing?.durationSec.toString() ?? "1",
    );
    if (!durationRaw) {
      return null;
    }

    const outputsRaw = await this.promptInput(
      "Outputs as item:amount, item:amount",
      existing ? this.formatIngredients(existing.outputs) : "",
    );
    if (!outputsRaw) {
      return null;
    }

    const inputsRaw = await this.promptInput(
      "Inputs as item:amount, item:amount",
      existing ? this.formatIngredients(existing.inputs) : "",
    );
    if (inputsRaw === null) {
      return null;
    }

    try {
      const durationSec = BigInt(durationRaw);
      if (durationSec <= 0n) {
        throw new Error("Duration must be positive.");
      }

      return {
        name,
        machineName,
        durationSec,
        outputs: this.parseIngredientList(outputsRaw, "output"),
        inputs: this.parseIngredientList(inputsRaw, "input"),
      };
    } catch (error) {
      await this.showMessage("Invalid Recipe", (error as Error).message);
      return null;
    }
  }

  private formatIngredients(ingredients: RecipeIngredient[]): string {
    return ingredients
      .map(
        (ingredient) =>
          `${getItemById(this.catalog, ingredient.itemId)?.name ?? ingredient.itemId}:${ingredient.amount.toString()}`,
      )
      .join(", ");
  }

  private parseIngredientList(raw: string, label: string): RecipeIngredient[] {
    if (!raw.trim()) {
      return [];
    }

    return raw.split(",").map((chunk) => {
      const [itemToken, amountToken] = chunk.split(":");
      if (!itemToken || !amountToken) {
        throw new Error(`Invalid ${label} "${chunk.trim()}". Use item:amount.`);
      }
      const item = resolveItemByName(this.catalog, itemToken);
      if (!item) {
        throw new Error(`Unknown item "${itemToken.trim()}".`);
      }
      const amount = BigInt(amountToken.trim());
      if (amount <= 0n) {
        throw new Error(`${label[0].toUpperCase()}${label.slice(1)} amount for "${item.name}" must be positive.`);
      }
      return {
        itemId: item.id,
        amount,
      };
    });
  }

  private persistCatalog(): void {
    const errors = validateCatalog(this.catalog);
    if (errors.length > 0) {
      throw new Error(errors[0]);
    }
    this.catalogStore.save(this.catalog);
  }
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function createAppWithDefaultStore(): IndustrialistApp {
  return new IndustrialistApp(
    new CatalogStore(path.join(process.cwd(), "data", "catalog.json")),
    new ChecklistStore(path.join(process.cwd(), "data", "checklists.json")),
  );
}




