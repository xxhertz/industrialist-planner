import blessed from "blessed";
import type { Widgets } from "blessed";
import path from "node:path";
import {
  buildChecklistEntry,
  buildChecklistItems,
  createChecklistItemId,
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
import { formatRecipeAmount, formatRecipeDuration } from "../core/amount";
import { CatalogStore, ChecklistStore } from "../core/storage";
import { Rational } from "../core/rational";
import { Catalog, Item, PlannerRequest, Recipe, RecipeIngredient } from "../core/types";

type KeyBinding = {
  keys: string[];
  listener: () => void;
};

type CatalogTab = "items" | "recipes";

type PlannerChoice = {
  recipeId: string;
  outputItemId?: string;
  label: string;
  recipeName: string;
  itemName?: string;
  index: number;
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
  private readonly keypressBindings: Array<
    (ch: string, key: Widgets.Events.IKeyEventArg) => void
  > = [];
  private readonly resizeBindings: Array<() => void> = [];
  private readonly consumeNextKeys = new Set<string>();
  private bindingToken = 0;
  private activeView: "home" | "catalog" | "planner" | "results" = "home";
  private catalog: Catalog = createEmptyCatalog();
  private currentTab: CatalogTab = "items";
  private lastResult: PlannerResult | null = null;
  private lastPlannerRequest: PlannerRequest | null = null;
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
    this.bindingToken += 1;
    while (this.bindings.length > 0) {
      const binding = this.bindings.pop();
      if (binding) {
        for (const key of binding.keys) {
          this.screen.unkey(key, binding.listener);
        }
      }
    }
    while (this.keypressBindings.length > 0) {
      const listener = this.keypressBindings.pop();
      if (listener) {
        this.screen.off("keypress", listener);
      }
    }
    while (this.resizeBindings.length > 0) {
      const listener = this.resizeBindings.pop();
      if (listener) {
        this.screen.off("resize", listener);
      }
    }
  }

  private bindViewKey(keys: string[], handler: () => void | Promise<void>): void {
    const token = this.bindingToken;
    for (const key of keys) {
      const listener = () => {
        if (this.bindingToken !== token) {
          return;
        }
        if (this.consumeNextKeys.has(key)) {
          this.consumeNextKeys.delete(key);
          return;
        }
        void handler();
      };
      this.bindings.push({ keys: [key], listener });
      this.screen.key([key], listener);
    }
  }

  private bindViewKeypress(
    handler: (ch: string, key: Widgets.Events.IKeyEventArg) => void | Promise<void>,
  ): void {
    const token = this.bindingToken;
    const listener = (ch: string, key: Widgets.Events.IKeyEventArg) => {
      if (this.bindingToken !== token) {
        return;
      }
      void handler(ch, key);
    };
    this.keypressBindings.push(listener);
    this.screen.on("keypress", listener);
  }

  private bindViewResize(handler: () => void): void {
    const token = this.bindingToken;
    const listener = () => {
      if (this.bindingToken !== token) {
        return;
      }
      handler();
    };
    this.resizeBindings.push(listener);
    this.screen.on("resize", listener);
  }

  private bindWrapNavigation(
    list: Widgets.ListElement | Widgets.ListTableElement,
    headerOffset = 0,
    onMove?: () => void,
  ): void {
    (list as unknown as { keys?: boolean; vi?: boolean }).keys = false;
    (list as unknown as { keys?: boolean; vi?: boolean }).vi = false;

    const getItemsLength = () =>
      ((list as unknown as { items?: Widgets.BlessedElement[] }).items ?? []).length;

    const moveSelection = (direction: "up" | "down") => {
      const total = getItemsLength();
      if (total <= headerOffset) {
        return;
      }
      const selectedRaw = (list as unknown as { selected?: number }).selected ?? headerOffset;
      const index = Math.max(selectedRaw - headerOffset, 0);
      const count = Math.max(total - headerOffset, 0);
      const nextIndex =
        direction === "up"
          ? index <= 0
            ? count - 1
            : index - 1
          : index >= count - 1
            ? 0
            : index + 1;
      list.select(nextIndex + headerOffset);
      this.screen.render();
    };

    this.bindViewKey(["up", "k"], () => {
      onMove?.();
      moveSelection("up");
    });
    this.bindViewKey(["down", "j"], () => {
      onMove?.();
      moveSelection("down");
    });
  }

  private suspendBindings(): () => void {
    const active = [...this.bindings];
    const token = this.bindingToken;
    for (const binding of active) {
      for (const key of binding.keys) {
        this.screen.unkey(key, binding.listener);
      }
    }
    return () => {
      if (this.bindingToken !== token) {
        return;
      }
      for (const binding of active) {
        this.screen.key(binding.keys, binding.listener);
      }
    };
  }

  private setActiveView(view: "home" | "catalog" | "planner" | "results"): void {
    this.activeView = view;
  }

  private setChrome(title: string, help: string): void {
    this.header.setContent(` {bold}${title}{/bold} `);
    this.footer.setContent(` ${help} `);
  }

  private clearBody(): void {
    this.body.children.slice().forEach((child: Widgets.Node) => child.destroy());
    this.screen.children
      .filter((child: Widgets.Node) => child !== this.header && child !== this.body && child !== this.footer)
      .forEach((child: Widgets.Node) => child.destroy());
  }

  private async promptInput(label: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => {
      const restoreBindings = this.suspendBindings();
      let finished = false;
      const onEnter = () => finish(null, initial);
      const prompt = blessed.prompt({
        parent: this.screen,
        border: "line",
        width: "70%",
        height: 9,
        top: "center",
        left: "center",
        label: ` ${label} `,
      });
      const finish = (_error: unknown, value: string | null) => {
        if (finished) {
          return;
        }
        finished = true;
        this.screen.unkey("enter", onEnter);
        prompt.destroy();
        restoreBindings();
        this.screen.render();
        resolve(value === null ? null : value.trim());
      };
      prompt.input(label, initial, finish);
      this.screen.key("enter", onEnter);
      this.screen.render();
    });
  }

  private async promptChoice(title: string, items: string[]): Promise<number | null> {
    return new Promise((resolve) => {
      const restoreBindings = this.suspendBindings();
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
        this.screen.unkey("escape", onEscape);
        this.consumeNextKeys.add("enter");
        setTimeout(() => {
          restoreBindings();
          this.screen.render();
          resolve(value);
        }, 0);
      };

      list.on("select", (_item: Widgets.BlessedElement, index: number) => finish(index));
      list.key(["enter"], () => {
        const index = (list as unknown as { selected?: number }).selected ?? 0;
        finish(index);
      });
      list.key(["escape", "q"], () => finish(null));
      const onEscape = () => finish(null);
      this.screen.key("escape", onEscape);
      list.focus();
      this.screen.render();
    });
  }

  private async promptMultiSelect(
    title: string,
    items: string[],
    initialSelected: boolean[],
  ): Promise<boolean[] | null> {
    return new Promise((resolve) => {
      const restoreBindings = this.suspendBindings();
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
        items: [],
        style: {
          selected: {
            bg: "blue",
          },
        },
      });

      const selected = items.map((_, index) => initialSelected[index] ?? false);

      const render = () => {
        list.setItems(
          items.map((item, index) => `${selected[index] ? "[x]" : "[ ]"} ${item}`),
        );
        const currentIndex = (list as unknown as { selected?: number }).selected ?? 0;
        list.select(Math.max(0, Math.min(currentIndex, items.length - 1)));
        this.screen.render();
      };

      const finish = (value: boolean[] | null) => {
        wrapper.destroy();
        restoreBindings();
        this.screen.render();
        resolve(value);
      };

      list.key(["space"], () => {
        const index = (list as unknown as { selected?: number }).selected ?? 0;
        if (index >= 0 && index < selected.length) {
          selected[index] = !selected[index];
          render();
        }
      });

      list.key(["enter"], () => finish([...selected]));
      list.key(["escape", "q"], () => finish(null));

      list.focus();
      render();
    });
  }

  private async confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const restoreBindings = this.suspendBindings();
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
        restoreBindings();
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
    this.setActiveView("home");
    this.clearViewBindings();
    this.clearBody();
    this.setChrome(
      "Industrialist Planner",
      "Enter select  q quit  c catalog  p planner  r results",
    );
    this.consumeNextKeys.delete("enter");
    this.consumeNextKeys.delete("space");

    blessed.box({
      parent: this.body,
      top: 1,
      left: 1,
      width: "100%-3",
      height: 5,
      tags: true,
      content:
        "Define named items and recipes, then calculate the smallest whole-machine chain needed to run at full efficiency.",
    });

    const menu = blessed.list({
      parent: this.body,
      top: 7,
      left: 1,
      width: "60%",
      height: 8,
      border: "line",
      keys: false,
      vi: false,
      mouse: true,
      items: ["Catalog", "Planner", "Results", "Quit"],
      style: {
        selected: {
          bg: "blue",
        },
      },
    });

    const handleMenuSelect = (index: number) => {
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
    };

    menu.on("select", (_item: Widgets.BlessedElement, index: number) => {
      handleMenuSelect(index);
    });

    this.bindViewKey(["q"], () => {
      if (this.activeView !== "home") {
        this.showHome();
        return;
      }
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
    this.bindViewKey(["enter"], () => {
      const selected = (menu as unknown as { selected?: number }).selected ?? 0;
      handleMenuSelect(selected);
    });

    this.bindWrapNavigation(menu as unknown as Widgets.ListElement);
    menu.focus();
    this.screen.render();
  }

  private showCatalog(): void {
    this.setActiveView("catalog");
    this.clearViewBindings();
    this.clearBody();
    if (this.currentTab === "items") {
      this.catalogSelection.items = 0;
    } else {
      this.catalogSelection.recipes = 0;
    }
    this.consumeNextKeys.delete("enter");
    this.consumeNextKeys.delete("space");
    this.setChrome(
      `Catalog: ${this.currentTab}`,
      "Tab switch  a add  e edit  d delete  v toggle  p planner  q home",
    );

    const errors = validateCatalog(this.catalog);
    const contentLeft = 1;
    const contentTop = 1;
    const contentWidth = "100%-4";
    blessed.box({
      parent: this.body,
      top: contentTop,
      left: contentLeft,
      width: contentWidth,
      height: 3,
      tags: true,
      content:
        errors.length > 0
          ? `{red-fg}${errors[0]}{/red-fg}`
          : `{green-fg}${this.catalog.items.length} items, ${this.catalog.recipes.length} recipes{/green-fg}`,
    });

    const table = blessed.listtable({
      parent: this.body,
      top: contentTop + 3,
      left: contentLeft,
      width: contentWidth,
      height: "100%-6",
      border: "line",
      keys: false,
      vi: false,
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
        const recipesUsingItem = (itemId: string) =>
          this.catalog.recipes
            .filter((recipe) => recipe.inputs.some((input) => input.itemId === itemId))
            .map((recipe) => recipe.name);
        const machinesProducingItem = (itemId: string) =>
          [
            ...new Set(
              this.catalog.recipes
                .filter((recipe) => recipe.outputs.some((output) => output.itemId === itemId))
                .map((recipe) => recipe.machineName),
            ),
          ];
        table.setData([
          ["Name", "Aliases", "Produced Via", "Machines Producing", "Show in Planner"],
          ...this.catalog.items.map((item) => [
            item.name,
            item.aliases.join(", "),
            recipesUsingItem(item.id).join(", "),
            machinesProducingItem(item.id).join(", "),
            item.showInPlanner ? "shown" : "hidden",
          ]),
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
                  `${getItemById(this.catalog, output.itemId)?.name ?? output.itemId} x${formatRecipeAmount(output.amount)}`,
              )
              .join(", "),
            `${formatRecipeDuration(recipe.durationSec)}s`,
            recipe.inputs
              .map(
                (input) =>
                  `${getItemById(this.catalog, input.itemId)?.name ?? input.itemId} x${formatRecipeAmount(input.amount)}`,
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

    const getLiveSelectedIndex = () => {
      const rows = getRowsForCurrentTab();
      if (rows.length === 0) {
        return -1;
      }

      const liveIndex = (table as unknown as { selected?: number }).selected;
      if (typeof liveIndex !== "number") {
        return getSelectedIndex();
      }

      return Math.max(0, Math.min(liveIndex - 1, rows.length - 1));
    };

    const syncStoredSelectionFromTable = () => {
      const index = getLiveSelectedIndex();
      if (index >= 0) {
        setSelection(index);
      }
    };

    const syncTableSelection = () => {
      if (getSelectedIndex() >= 0) {
        table.select(getSelectedIndex() + 1);
      }
    };

    const applySelection = (index: number) => {
      const rows = getRowsForCurrentTab();
      if (rows.length === 0) {
        return;
      }
      const nextIndex = Math.max(0, Math.min(index, rows.length - 1));
      setSelection(nextIndex);
      table.select(nextIndex + 1);
      this.screen.render();
    };

    this.bindViewKey(["tab"], () => {
      this.currentTab = this.currentTab === "items" ? "recipes" : "items";
      this.showCatalog();
    });
    this.bindViewKey(["q"], () => this.showHome());
    this.bindViewKey(["p"], () => this.showPlannerView());
    this.bindViewKey(["a"], async () => {
      const desiredIndex = getLiveSelectedIndex();
      syncStoredSelectionFromTable();
      if (this.currentTab === "items") {
        await this.addItem();
      } else {
        await this.addRecipe();
      }
      render();
      applySelection(desiredIndex);
    });
    this.bindViewKey(["e"], async () => {
      const desiredIndex = getLiveSelectedIndex();
      syncStoredSelectionFromTable();
      if (this.currentTab === "items") {
        const item = this.catalog.items[getLiveSelectedIndex()];
        if (item) {
          await this.editItem(item);
        }
      } else {
        const recipe = this.catalog.recipes[getLiveSelectedIndex()];
        if (recipe) {
          await this.editRecipe(recipe);
        }
      }
      render();
      applySelection(desiredIndex);
    });
    this.bindViewKey(["enter"], async () => {
      const desiredIndex = getLiveSelectedIndex();
      syncStoredSelectionFromTable();
      if (this.currentTab === "items") {
        const item = this.catalog.items[getLiveSelectedIndex()];
        if (item) {
          await this.editItem(item);
        }
      } else {
        const recipe = this.catalog.recipes[getLiveSelectedIndex()];
        if (recipe) {
          await this.editRecipe(recipe);
        }
      }
      render();
      applySelection(desiredIndex);
    });
    this.bindViewKey(["d"], async () => {
      const desiredIndex = getLiveSelectedIndex();
      syncStoredSelectionFromTable();
      if (this.currentTab === "items") {
        const item = this.catalog.items[getLiveSelectedIndex()];
        if (item) {
          const deleted = await this.deleteItem(item);
          if (deleted) {
            return;
          }
        }
      } else {
        const recipe = this.catalog.recipes[getLiveSelectedIndex()];
        if (recipe) {
          const deleted = await this.deleteRecipe(recipe);
          if (deleted) {
            return;
          }
        }
      }
      render();
      applySelection(desiredIndex);
    });
    this.bindViewKey(["v"], () => {
      if (this.currentTab !== "items") {
        return;
      }
      syncStoredSelectionFromTable();
      const item = this.catalog.items[getLiveSelectedIndex()];
      if (!item) {
        return;
      }
      const selectedIndex = getLiveSelectedIndex();
      item.showInPlanner = !item.showInPlanner;
      this.persistCatalog();
      render();
      if (selectedIndex >= 0) {
        table.select(selectedIndex + 1);
      }
      this.screen.render();
    });
    table.on("select", (_item: Widgets.BlessedElement, index: number) => {
      setSelection(index - 1);
    });

    render();
    syncTableSelection();
    this.bindWrapNavigation(table as unknown as Widgets.ListTableElement, 1);
    table.focus();
  }

  private getPlannerChoices(): PlannerChoice[] {
    let index = 0;
    return this.catalog.recipes.flatMap((recipe) =>
      recipe.outputs.length > 0
        ? recipe.outputs
            .filter((output) => {
              const item = getItemById(this.catalog, output.itemId);
              return item?.showInPlanner ?? true;
            })
            .map((output) => {
            const item = getItemById(this.catalog, output.itemId);
            const itemName = item?.name ?? output.itemId;
            const entry: PlannerChoice = {
              recipeId: recipe.id,
              outputItemId: output.itemId,
              label: `${itemName} via ${recipe.name}`,
              recipeName: recipe.name,
              itemName,
              index,
            };
            index += 1;
            return entry;
          })
        : [
            {
              recipeId: recipe.id,
              label: `${recipe.name} (consumption)`,
              recipeName: recipe.name,
              itemName: undefined,
              index: index++,
            },
          ],
    );
  }

  private showPlannerView(): void {
    this.setActiveView("planner");
    this.clearViewBindings();
    this.clearBody();
    this.setChrome("Planner Setup", "Enter run  Esc home  Type to search");

    blessed.box({
      parent: this.body,
      top: 1,
      left: 1,
      width: "100%-3",
      height: 4,
      content:
        "Select the recipe or output you want to plan around. Default target is 1 machine; tweak target mode/value from Results (t).",
    });

    let searchQuery = "";
    const choiceKey = (choice: PlannerChoice) =>
      `${choice.recipeId}:${choice.outputItemId ?? "consumption"}`;
    let hasActiveSearch = false;
    let baseSelectionKey: string | null = null;
    let userMovedSelection = false;
    let isAutoSelecting = false;
    let displayIndexToChoiceIndex: Array<number | null> = [];
    let choiceIndexToDisplayIndex: number[] = [];
    const searchBox = blessed.box({
      parent: this.body,
      top: 5,
      left: 1,
      width: "100%-4",
      height: 3,
      border: "line",
      label: " Search ",
      tags: true,
      content: " Search: ",
    });

    const plannerChoices = this.getPlannerChoices();
    let filteredChoices = plannerChoices;
    const list = blessed.list({
      parent: this.body,
      top: 8,
      left: 1,
      width: "100%-4",
      height: "100%-10",
      border: "line",
      keys: false,
      vi: false,
      mouse: true,
      tags: true,
      items: filteredChoices.map((choice) => choice.label),
      style: {
        item: {
          fg: "white",
        },
        selected: {
          bg: "blue",
        },
      },
    });

    const renderSearch = (matchCount: number, totalCount: number) => {
      const summary =
        searchQuery.trim().length === 0 ? "" : ` (${matchCount}/${totalCount})`;
      searchBox.setContent(` Search: ${searchQuery}${summary}`);
    };

    const applyFilter = () => {
      const selectedDisplayIndex = (list as unknown as { selected?: number }).selected ?? 0;
      const resolveChoiceIndex = (displayIndex: number) => {
        if (displayIndexToChoiceIndex[displayIndex] !== null) {
          return displayIndexToChoiceIndex[displayIndex] ?? null;
        }
        for (let offset = 1; offset < displayIndexToChoiceIndex.length; offset += 1) {
          const prevIndex = displayIndex - offset;
          if (prevIndex >= 0) {
            const prevChoice = displayIndexToChoiceIndex[prevIndex];
            if (prevChoice !== null && prevChoice !== undefined) {
              return prevChoice;
            }
          }
          const nextIndex = displayIndex + offset;
          if (nextIndex < displayIndexToChoiceIndex.length) {
            const nextChoice = displayIndexToChoiceIndex[nextIndex];
            if (nextChoice !== null && nextChoice !== undefined) {
              return nextChoice;
            }
          }
        }
        return null;
      };
      const selectedChoiceIndex = resolveChoiceIndex(selectedDisplayIndex);
      const previousSelection =
        selectedChoiceIndex !== null && selectedChoiceIndex !== undefined
          ? filteredChoices[selectedChoiceIndex]
          : undefined;
      const trimmed = searchQuery.trim().toLowerCase();

      if (!hasActiveSearch && trimmed.length > 0) {
        hasActiveSearch = true;
        userMovedSelection = false;
        baseSelectionKey = previousSelection ? choiceKey(previousSelection) : null;
      } else if (hasActiveSearch && trimmed.length === 0) {
        hasActiveSearch = false;
      }

      const scored = plannerChoices.map((choice) => {
        const match =
          trimmed.length === 0 ||
          choice.recipeName.toLowerCase().includes(trimmed) ||
          (choice.itemName ? choice.itemName.toLowerCase().includes(trimmed) : false);
        return { choice, match };
      });
      const matchCount = scored.filter((entry) => entry.match).length;
      scored.sort((a, b) => {
        if (a.match === b.match) {
          return a.choice.index - b.choice.index;
        }
        return a.match ? -1 : 1;
      });
      const orderedEntries =
        trimmed.length > 0 && matchCount > 0 && matchCount < scored.length
          ? [...scored.filter((entry) => entry.match), ...scored.filter((entry) => !entry.match)]
          : [...scored];
      filteredChoices = orderedEntries.map((entry) => entry.choice);

      displayIndexToChoiceIndex = [];
      choiceIndexToDisplayIndex = [];
      const displayItems: string[] = [];
      const addEntry = (entry: (typeof orderedEntries)[number], choiceIndex: number) => {
        displayItems.push(entry.choice.label);
        displayIndexToChoiceIndex.push(choiceIndex);
        choiceIndexToDisplayIndex[choiceIndex] = displayItems.length - 1;
      };

      if (trimmed.length > 0 && matchCount > 0 && matchCount < scored.length) {
        for (let i = 0; i < matchCount; i += 1) {
          const entry = orderedEntries[i];
          if (entry) {
            addEntry(entry, i);
          }
        }
        const divider = "────────────";
        displayItems.push(divider);
        displayIndexToChoiceIndex.push(null);
        for (let i = matchCount; i < orderedEntries.length; i += 1) {
          const entry = orderedEntries[i];
          if (entry) {
            addEntry(entry, i);
          }
        }
      } else {
        for (let i = 0; i < orderedEntries.length; i += 1) {
          const entry = orderedEntries[i];
          if (entry) {
            addEntry(entry, i);
          }
        }
      }

      list.setItems(displayItems);
      const listItems = (list as unknown as { items?: Widgets.BlessedElement[] }).items ?? [];
      for (let i = 0; i < listItems.length; i += 1) {
        const item = listItems[i];
        const choiceIndex = displayIndexToChoiceIndex[i];
        if (!item) {
          continue;
        }
        if (choiceIndex === null || choiceIndex === undefined) {
          item.style = {
            ...(item.style ?? {}),
            fg: "yellow",
            bold: false,
          };
          (item as unknown as { dirty?: boolean }).dirty = true;
          continue;
        }
        const entry = orderedEntries[choiceIndex];
        const isMuted = trimmed.length > 0 && !entry?.match;
        item.style = {
          ...(item.style ?? {}),
          fg: "white",
          bold: trimmed.length > 0 ? !isMuted : false,
        };
        (item as unknown as { dirty?: boolean }).dirty = true;
      }

      const previousKey = previousSelection ? choiceKey(previousSelection) : null;
      const previousMatch = orderedEntries.find(
        (entry) => previousKey && choiceKey(entry.choice) === previousKey,
      )?.match;
      const firstMatchIndex = orderedEntries.findIndex((entry) => entry.match);

      let nextIndex = 0;
      if (trimmed.length === 0) {
        if (!userMovedSelection && baseSelectionKey) {
          const restoredIndex = filteredChoices.findIndex(
            (choice) => choiceKey(choice) === baseSelectionKey,
          );
          if (restoredIndex >= 0) {
            nextIndex = restoredIndex;
          }
        } else if (previousKey) {
          const previousIndex = filteredChoices.findIndex(
            (choice) => choiceKey(choice) === previousKey,
          );
          if (previousIndex >= 0) {
            nextIndex = previousIndex;
          }
        }
        baseSelectionKey = null;
      } else if (previousKey && previousMatch) {
        const previousIndex = filteredChoices.findIndex(
          (choice) => choiceKey(choice) === previousKey,
        );
        if (previousIndex >= 0) {
          nextIndex = previousIndex;
        }
      } else if (firstMatchIndex >= 0) {
        nextIndex = firstMatchIndex;
      }

      isAutoSelecting = true;
      const displayIndex = choiceIndexToDisplayIndex[nextIndex] ?? 0;
      list.select(Math.max(0, displayIndex));
      isAutoSelecting = false;

      renderSearch(matchCount, scored.length);
      this.screen.render();
    };

    const run = async () => {
      const selectedDisplayIndex = (list as unknown as { selected?: number }).selected ?? 0;
      const choiceIndex =
        displayIndexToChoiceIndex[selectedDisplayIndex] ??
        displayIndexToChoiceIndex.find((value) => value !== null);
      if (displayIndexToChoiceIndex[selectedDisplayIndex] === null) {
        return;
      }
      const choice =
        choiceIndex !== null && choiceIndex !== undefined
          ? filteredChoices[choiceIndex]
          : undefined;
      if (!choice) {
        return;
      }
      const recipe = getRecipeById(this.catalog, choice.recipeId);
      if (!recipe) {
        return;
      }
      await this.runPlannerWizard(recipe, choice.outputItemId);
    };

    this.bindViewKey(["enter"], run);
    this.bindViewKey(["escape"], () => this.showHome());
    this.bindViewKeypress((ch, key) => {
      if (key.full) {
        const fullLower = key.full.toLowerCase();
        const ctrlBackspaceVariants = new Set([
          "c-backspace",
          "c-bs",
          "c-?",
          "c-h",
        ]);
        if (ctrlBackspaceVariants.has(fullLower)) {
          if (searchQuery.length > 0) {
            searchQuery = "";
            applyFilter();
          }
          return;
        }
      }
      if (key.meta) {
        return;
      }
      const isClearShortcut =
        (key.ctrl && (key.name === "u" || key.name === "w" || key.name === "backspace")) ||
        key.sequence === "\x17" ||
        key.sequence === "\x08";
      if (isClearShortcut) {
        if (searchQuery.length > 0) {
          searchQuery = "";
          applyFilter();
        }
        return;
      }
      if (["up", "down", "k", "j", "enter", "escape", "tab"].includes(key.name ?? "")) {
        return;
      }
      if (key.name === "backspace") {
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          applyFilter();
        }
        return;
      }
      if (typeof ch === "string" && ch.length === 1 && ch >= " ") {
        searchQuery += ch;
        applyFilter();
      }
    });
    this.bindWrapNavigation(list as unknown as Widgets.ListElement, 0, () => {
      if (!isAutoSelecting && hasActiveSearch) {
        userMovedSelection = true;
      }
    });
    list.on("select", () => {
      if (!isAutoSelecting && hasActiveSearch) {
        userMovedSelection = true;
      }
      const selectedDisplayIndex = (list as unknown as { selected?: number }).selected ?? 0;
      if (displayIndexToChoiceIndex[selectedDisplayIndex] === null) {
        const fallbackIndex =
          displayIndexToChoiceIndex.findIndex((value) => value !== null) ?? 0;
        if (fallbackIndex >= 0) {
          list.select(fallbackIndex);
          this.screen.render();
        }
      }
    });
    applyFilter();
    list.focus();
    this.screen.render();
  }

  private async runPlannerWizard(rootRecipe: Recipe, rootOutputItemId?: string): Promise<void> {
    let resolvedOutputItemId = rootOutputItemId;
    if (!resolvedOutputItemId && rootRecipe.outputs.length > 0) {
      resolvedOutputItemId = rootRecipe.outputs[0]?.itemId;
    }
    const targetMode: PlannerRequest["targetMode"] = "machineCount";
    const targetValue = "1";

    const request: PlannerRequest = {
      rootRecipeId: rootRecipe.id,
      targetMode,
      targetValue,
      recipeSelections: {},
      ...(resolvedOutputItemId ? { rootOutputItemId: resolvedOutputItemId } : {}),
    };
    this.lastPlannerRequest = request;

    while (true) {
      try {
        const result = planFactory(this.catalog, request);
        this.lastPlannerRequest = {
          ...request,
          recipeSelections: { ...result.selections },
        };
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
          error instanceof PlannerError
            ? error.message
            : error instanceof Error
              ? `Unexpected planner failure: ${error.message}`
              : `Unexpected planner failure: ${String(error)}`;
        await this.showMessage("Planner Error", message);
        this.showPlannerView();
        return;
      }
    }
  }

  private showResults(result: PlannerResult): void {
    this.setActiveView("results");
    this.clearViewBindings();
    this.clearBody();
    this.setChrome(
      "Results",
      "up/down move  space/enter toggle  a all  x clear  t target  s caps  p planner  q home",
    );

    const resultKey = createChecklistResultKey(result);
    let checklistItems = buildChecklistItems(result, this.checklistStore.load(resultKey));
    const rootRecipe = getRecipeById(this.catalog, result.rootRecipeId);
    const contentLeft = 1;
    const contentTop = 1;
    const bodyWidth = Number(
      (this.body as unknown as { width?: number | string }).width ?? this.screen.width,
    );
    const contentWidth = Math.max(10, bodyWidth - 2);
    const headerHeight = 4;
    const headerLeft = 1;
    const headerWidth = Math.max(10, contentWidth - 1);
    const upperTop = contentTop + headerHeight + 1;
    const upperHeight = "50%-4";
    const lowerTop = "50%+2";
    const lowerHeight = "50%-4";
    const columnGap = 1;
    const upperLeftWidth = Math.max(
      10,
      Math.floor((contentWidth - columnGap) * 0.6),
    );
    const upperRightWidth = Math.max(
      10,
      contentWidth - columnGap - upperLeftWidth - 2,
    );
    const upperRightLeft = contentLeft + upperLeftWidth + columnGap;
    const lowerLeftWidth = Math.max(
      10,
      Math.floor((contentWidth - columnGap) * 0.41),
    );
    const lowerRightWidth = Math.max(
      10,
      contentWidth - columnGap - lowerLeftWidth - 2,
    );
    const lowerRightLeft = contentLeft + lowerLeftWidth + columnGap;
    blessed.box({
      parent: this.body,
      top: contentTop,
      left: headerLeft,
      width: headerWidth,
      height: headerHeight,
      tags: true,
      padding: {
        right: 1,
      },
      content:
        (result.rootOutputItemId
          ? `{bold}${rootRecipe?.name ?? result.rootRecipeId}{/bold} for {bold}${result.rootOutputItemLabel}{/bold}\n` +
            `Scale factor: ${result.scaleFactor.toString()}\n` +
            `Achieved output: ${formatRate(result.achievedOutputPerSecond)}`
          : `{bold}${rootRecipe?.name ?? result.rootRecipeId}{/bold} consumption plan\n` +
            `Scale factor: ${result.scaleFactor.toString()}\n` +
            `Steady inputs: see process order and external sources`),
    });

    blessed.listtable({
      parent: this.body,
      top: upperTop,
      left: contentLeft,
      width: upperLeftWidth,
      height: upperHeight,
      border: "line",
      label: " Process Order ",
      data: [
        ["Machine", "Item", "Exact", "Scaled", "Rate/sec", "Net i/s"],
        ...result.processRows.map((row) =>
          row.kind === "machine"
            ? [
                row.machineName,
                this.formatProcessItem(row),
                row.exactMachineCount.toFractionString(),
                row.scaledMachineCount.toString(),
                row.isConsumption ? "n/a" : row.outputPerSecond.toDecimalString(4),
                formatNetRate(result.itemNetRates[row.itemId] ?? Rational.zero()),
              ]
            : [
                "",
                row.itemLabel,
                row.exactRate.toFractionString(),
                row.scaledRate.toDecimalString(4),
                "external",
                formatNetRate(result.itemNetRates[row.itemId] ?? Rational.zero()),
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
      top: upperTop,
      left: upperRightLeft,
      width: upperRightWidth,
      height: upperHeight,
      border: "line",
      label: " External ",
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
      top: lowerTop,
      left: contentLeft,
      width: lowerLeftWidth,
      height: lowerHeight,
      border: "line",
      label: " Checklist ",
      keys: false,
      vi: false,
      mouse: true,
      style: {
        selected: {
          bg: "blue",
        },
      },
    });

    const dependencyTree = blessed.box({
      parent: this.body,
      top: lowerTop,
      left: lowerRightLeft,
      width: lowerRightWidth,
      height: lowerHeight,
      border: "line",
      label: " Dependency Tree ",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
    });

    const buildCheckedMachineMap = () => {
      const checkedById = new Map<string, boolean>();
      for (let index = 0; index < result.processRows.length; index += 1) {
        const row = result.processRows[index];
        if (!row) {
          continue;
        }
        const id = createChecklistItemId(row);
        checkedById.set(id, Boolean(checklistItems[index]?.checked));
      }

      const checkedMachineRows = new Map<string, boolean>();
      for (const row of result.processRows) {
        if (row.kind !== "machine") {
          continue;
        }
        const id = createChecklistItemId(row);
        const key = `${row.recipeId}:${row.itemId}`;
        checkedMachineRows.set(key, checkedById.get(id) ?? false);
      }
      return checkedMachineRows;
    };

    const renderDependencyTree = () => {
      dependencyTree.setContent(this.renderDependencyTree(result, buildCheckedMachineMap()));
    };

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
      renderDependencyTree();
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
    this.bindViewKey(["s"], async () => {
      if (!this.lastPlannerRequest) {
        await this.showMessage("No Plan", "Run the planner first.");
        return;
      }

      const capChoices = this.getRecipeCapChoices(result);
      if (capChoices.length === 0) {
        await this.showMessage("No Machines", "This plan has no machines to cap.");
        return;
      }

      const existingCaps = this.lastPlannerRequest.perRecipeCaps ?? {};
      const selected = await this.promptMultiSelect(
        "Cap machines (space to toggle)",
        capChoices.map((choice) => choice.label),
        capChoices.map((choice) => Boolean(existingCaps[choice.recipeId])),
      );
      if (!selected) {
        return;
      }

      const perRecipeCaps: Record<string, string> = {};
      for (let index = 0; index < capChoices.length; index += 1) {
        if (!selected[index]) {
          continue;
        }
        const choice = capChoices[index];
        const currentCap = existingCaps[choice.recipeId] ?? "1";
        const capValue = await this.promptInput(
          `Cap for ${choice.label}`,
          currentCap,
        );
        if (capValue === null) {
          return;
        }
        if (capValue.trim()) {
          perRecipeCaps[choice.recipeId] = capValue.trim();
        }
      }

      const request: PlannerRequest = {
        ...this.lastPlannerRequest,
        ...(Object.keys(perRecipeCaps).length > 0 ? { perRecipeCaps } : {}),
        recipeSelections: { ...this.lastPlannerRequest.recipeSelections },
      };
      if (Object.keys(perRecipeCaps).length === 0) {
        delete request.perRecipeCaps;
      }

      try {
        const updated = planFactory(this.catalog, request);
        this.lastPlannerRequest = {
          ...request,
          recipeSelections: { ...updated.selections },
        };
        this.lastResult = updated;
      this.showResults(updated);
      } catch (error) {
        const message =
          error instanceof PlannerError ? error.message : "Unexpected planner failure.";
        await this.showMessage("Planner Error", message);
      }
    });
    this.bindViewKey(["t"], async () => {
      if (!this.lastPlannerRequest) {
        await this.showMessage("No Plan", "Run the planner first.");
        return;
      }

      const supportsOutputPlanning = Boolean(
        this.lastPlannerRequest.rootOutputItemId ?? result.rootOutputItemId,
      );
      let targetMode: PlannerRequest["targetMode"] = "machineCount";

      if (supportsOutputPlanning) {
        const targetModeIndex = await this.promptChoice("Target mode", [
          "Machine count",
          "Output per second",
        ]);
        if (targetModeIndex === null) {
          return;
        }
        targetMode = targetModeIndex === 0 ? "machineCount" : "outputPerSecond";
      }

      const targetValue = await this.promptInput(
        targetMode === "machineCount" ? "Desired machine count" : "Desired output per second",
        this.lastPlannerRequest.targetValue ?? "1",
      );
      if (!targetValue) {
        return;
      }

      const request: PlannerRequest = {
        ...this.lastPlannerRequest,
        targetMode,
        targetValue,
        recipeSelections: { ...this.lastPlannerRequest.recipeSelections },
      };

      try {
        const updated = planFactory(this.catalog, request);
        this.lastPlannerRequest = {
          ...request,
          recipeSelections: { ...updated.selections },
        };
        this.lastResult = updated;
        this.showResults(updated);
      } catch (error) {
        const message =
          error instanceof PlannerError ? error.message : "Unexpected planner failure.";
        await this.showMessage("Planner Error", message);
      }
    });
    this.bindViewKey(["space", "enter"], () => toggleSelectedChecklistItem());
    this.bindViewKey(["a"], () => setAllChecklistItems(true));
    this.bindViewKey(["x"], () => setAllChecklistItems(false));

    renderChecklist();
    checklist.focus();
    this.bindWrapNavigation(checklist as unknown as Widgets.ListElement);
    this.bindViewResize(() => this.showResults(result));
  }

  private formatProcessItem(row: ProcessMachineRow): string {
    if (row.byproducts.length === 0) {
      return row.itemLabel;
    }
    return `${row.itemLabel} (+${row.byproducts.map((byproduct) => byproduct.itemLabel).join(", ")})`;
  }

  private renderDependencyTree(
    result: PlannerResult,
    checkedMachineRows: Map<string, boolean>,
  ): string {
    const lines: string[] = [];
    const visited = new Set<string>();

    const visit = (recipeId: string, depth: number, displayItemId?: string) => {
      const recipe = getRecipeById(this.catalog, recipeId);
      const summary = result.recipeSummaries.find((entry) => entry.recipeId === recipeId);
      if (!recipe || !summary) {
        return;
      }

      const output = displayItemId
        ? summary.outputsPerSecond.find((entry) => entry.itemId === displayItemId) ??
          summary.outputsPerSecond[0]
        : undefined;
      const byproducts = output
        ? summary.outputsPerSecond
            .filter((entry) => entry.itemId !== output.itemId)
            .map((entry) => entry.itemLabel)
        : [];

      const indent = "  ".repeat(depth);
      const itemLabel = output?.itemLabel ?? "consumption";
      const machineKey = `${recipeId}:${output?.itemId ?? `consumption:${recipeId}`}`;
      const isChecked = checkedMachineRows.get(machineKey) ?? false;
      if (isChecked) {
        if (depth === 0) {
          lines.push(
            `${indent}${recipe.machineName} [${itemLabel}${byproducts.length > 0 ? ` + ${byproducts.join(", ")}` : ""}] x${summary.scaledMachineCount.toString()} [x]`,
          );
        } else {
          lines.push(`${indent}${recipe.machineName} [${itemLabel}] [x]`);
        }
        return;
      }

      lines.push(
        `${indent}${recipe.machineName} [${itemLabel}${byproducts.length > 0 ? ` + ${byproducts.join(", ")}` : ""}] x${summary.scaledMachineCount.toString()}`,
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

        const edgeLabel = getCompactItemLabel(this.catalog, edge.itemId);
        const edgeKey = `${edge.producerRecipeId}:${edge.itemId}`;
        const edgeChecked = checkedMachineRows.get(edgeKey) ?? false;
        if (edgeChecked) {
          const producerRecipe = getRecipeById(this.catalog, edge.producerRecipeId);
          lines.push(
            `${itemIndent}${producerRecipe?.machineName ?? edgeLabel} [${edgeLabel}] [x]`,
          );
          continue;
        }

        lines.push(`${itemIndent}${edgeLabel}`);
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

  private getRecipeCapChoices(result: PlannerResult): Array<{ recipeId: string; label: string }> {
    return result.recipeSummaries.map((summary) => {
      const outputLabel = summary.outputsPerSecond[0]?.itemLabel ?? "consumption";
      return {
        recipeId: summary.recipeId,
        label: `${outputLabel} via ${summary.machineName}`,
      };
    });
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
      showInPlanner: true,
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

  private async deleteItem(item: Item): Promise<boolean> {
    const beforeLength = this.catalog.items.length;
    const used = this.catalog.recipes.some(
      (recipe) =>
        recipe.outputs.some((output) => output.itemId === item.id) ||
        recipe.inputs.some((input) => input.itemId === item.id),
    );
    if (used) {
      await this.showMessage("Cannot Delete", "This item is still used by one or more recipes.");
      return false;
    }
    const choice = await this.promptChoice(`Delete item "${item.name}"?`, [
      "Delete item",
      "Cancel",
    ]);
    if (choice !== 0) {
      return false;
    }
    this.catalog.items = this.catalog.items.filter((entry) => entry.id !== item.id);
    this.persistCatalog();
    if (this.catalog.items.length !== beforeLength) {
      this.showCatalog();
    }
    return true;
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

  private async deleteRecipe(recipe: Recipe): Promise<boolean> {
    const beforeLength = this.catalog.recipes.length;
    const choice = await this.promptChoice(`Delete recipe "${recipe.name}"?`, [
      "Delete recipe",
      "Cancel",
    ]);
    if (choice !== 0) {
      return false;
    }
    this.catalog.recipes = this.catalog.recipes.filter((entry) => entry.id !== recipe.id);
    this.persistCatalog();
    if (this.catalog.recipes.length !== beforeLength) {
      this.showCatalog();
    }
    return true;
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
      existing ? formatRecipeDuration(existing.durationSec) : "1",
    );
    if (!durationRaw) {
      return null;
    }

    const outputsRaw = await this.promptInput(
      "Outputs as item:amount, item:amount (optional)",
      existing ? this.formatIngredients(existing.outputs) : "",
    );
    if (outputsRaw === null) {
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
      const durationSec = durationRaw.trim();
      const parsedDuration = Rational.parse(durationSec);
      if (parsedDuration.compare(Rational.zero()) <= 0) {
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
          `${getItemById(this.catalog, ingredient.itemId)?.name ?? ingredient.itemId}:${formatRecipeAmount(ingredient.amount)}`,
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
      const amount = amountToken.trim();
      const parsedAmount = Rational.parse(amount);
      if (parsedAmount.compare(Rational.zero()) <= 0) {
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

function formatNetRate(rate: Rational): string {
  if (rate.isZero()) {
    return "0 i/s";
  }
  const value = rate.toDecimalString(4);
  return `${value.startsWith("-") ? value : `+${value}`} i/s`;
}

export function createAppWithDefaultStore(): IndustrialistApp {
  return new IndustrialistApp(
    new CatalogStore(path.join(process.cwd(), "data", "catalog.json")),
    new ChecklistStore(path.join(process.cwd(), "data", "checklists.json")),
  );
}
















