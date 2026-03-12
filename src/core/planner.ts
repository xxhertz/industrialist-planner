import { parseRecipeAmount, parseRecipeDuration } from "./amount";
import {
  getCompactItemLabel,
  getItemById,
  getRecipeById,
  getRecipeProducers,
  validateCatalog,
} from "./catalog";
import { Rational, lcm } from "./rational";
import { Catalog, ItemId, PlannerRequest, Recipe, RecipeId } from "./types";

const CONSUMPTION_LABEL = "consumption";

export class PlannerError extends Error {}

export class MissingRecipeSelectionError extends PlannerError {
  constructor(
    public readonly itemId: ItemId,
    public readonly producerRecipeIds: RecipeId[],
  ) {
    super(`Multiple recipes can produce ${itemId}. A selection is required.`);
  }
}

export class CycleDetectedError extends PlannerError {
  constructor(public readonly path: RecipeId[]) {
    super(`Cycle detected in recipe graph: ${path.join(" -> ")}`);
  }
}

export interface OutputRateSummary {
  itemId: ItemId;
  itemName: string;
  itemLabel: string;
  rate: Rational;
}

export interface RecipePlanSummary {
  recipeId: RecipeId;
  recipeName: string;
  machineName: string;
  exactMachineCount: Rational;
  scaledMachineCount: bigint;
  outputsPerSecond: OutputRateSummary[];
  inputsPerSecond: Array<{
    itemId: ItemId;
    itemName: string;
    itemLabel: string;
    rate: Rational;
  }>;
}

export interface ExternalSourceSummary {
  itemId: ItemId;
  itemName: string;
  itemLabel: string;
  exactRate: Rational;
  scaledRate: Rational;
}

export interface DependencyEdge {
  itemId: ItemId;
  itemName: string;
  producerRecipeId?: RecipeId;
}

export interface ProcessMachineRow {
  kind: "machine";
  recipeId: RecipeId;
  recipeName: string;
  machineName: string;
  itemId: ItemId;
  itemLabel: string;
  exactMachineCount: Rational;
  scaledMachineCount: bigint;
  outputPerSecond: Rational;
  isConsumption: boolean;
  byproducts: Array<{
    itemId: ItemId;
    itemLabel: string;
    rate: Rational;
  }>;
}

export interface ProcessSourceRow {
  kind: "source";
  itemId: ItemId;
  itemLabel: string;
  exactRate: Rational;
  scaledRate: Rational;
}

export type ProcessRow = ProcessMachineRow | ProcessSourceRow;

export interface PlannerResult {
  rootRecipeId: RecipeId;
  rootOutputItemId?: ItemId;
  rootOutputItemLabel: string;
  scaleFactor: bigint;
  achievedOutputPerSecond: Rational;
  itemNetRates: Record<ItemId, Rational>;
  recipeSummaries: RecipePlanSummary[];
  externalSources: ExternalSourceSummary[];
  dependencyGraph: Record<RecipeId, DependencyEdge[]>;
  processRows: ProcessRow[];
  selections: Record<ItemId, RecipeId>;
}

function getRecipeOutput(recipe: Recipe, itemId: ItemId) {
  return recipe.outputs.find((output) => output.itemId === itemId);
}

function getAmountPerSecond(amount: Recipe["inputs"][number]["amount"], durationSec: Recipe["durationSec"]): Rational {
  return parseRecipeAmount(amount).div(parseRecipeDuration(durationSec));
}

function getOutputRatePerMachine(recipe: Recipe, outputItemId: ItemId): Rational {
  const output = getRecipeOutput(recipe, outputItemId);
  if (!output) {
    throw new PlannerError(`Recipe ${recipe.name} does not produce ${outputItemId}.`);
  }
  return getAmountPerSecond(output.amount, recipe.durationSec);
}

function getInputRatePerMachine(recipe: Recipe, itemId: ItemId): Rational {
  const ingredient = recipe.inputs.find((input) => input.itemId === itemId);
  if (!ingredient) {
    return Rational.zero();
  }
  return getAmountPerSecond(ingredient.amount, recipe.durationSec);
}

function addToRateMap(target: Map<ItemId, Rational>, itemId: ItemId, value: Rational): void {
  const existing = target.get(itemId) ?? Rational.zero();
  target.set(itemId, existing.add(value));
}

function addToMachineMap(target: Map<RecipeId, Rational>, recipeId: RecipeId, value: Rational): void {
  const existing = target.get(recipeId) ?? Rational.zero();
  target.set(recipeId, existing.add(value));
}

function roundRational(value: Rational): bigint {
  if (value.numerator < 0n) {
    throw new PlannerError("Cannot round negative machine counts.");
  }
  const floor = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  if (remainder * 2n >= value.denominator) {
    return floor + 1n;
  }
  return floor;
}

function getMaxScaleFactorForCaps(
  recipeMachines: Map<RecipeId, Rational>,
  perRecipeCaps: Map<RecipeId, bigint>,
): bigint {
  let maxScaleFactor: bigint | null = null;
  for (const [recipeId, cap] of perRecipeCaps.entries()) {
    const machineCount = recipeMachines.get(recipeId);
    if (!machineCount || machineCount.numerator <= 0n) {
      continue;
    }
    const bound = (cap * machineCount.denominator) / machineCount.numerator;
    if (maxScaleFactor === null || bound < maxScaleFactor) {
      maxScaleFactor = bound;
    }
  }
  return maxScaleFactor ?? 1n;
}

function getScaledMachineCounts(
  recipeMachines: Map<RecipeId, Rational>,
  perRecipeCaps?: Map<RecipeId, bigint>,
): {
  scaleFactor: bigint;
  scaledMachineCounts: Map<RecipeId, bigint>;
} {
  let scaleFactor = 1n;
  for (const machineCount of recipeMachines.values()) {
    scaleFactor = lcm(scaleFactor, machineCount.denominator);
  }

  const scaledMachineCounts = new Map<RecipeId, bigint>();
  if (!perRecipeCaps || perRecipeCaps.size === 0) {
    const scaledFactor = Rational.fromBigInt(scaleFactor);
    for (const [recipeId, exactMachineCount] of recipeMachines.entries()) {
      const scaledMachineCount = exactMachineCount.mul(scaledFactor);
      scaledMachineCounts.set(recipeId, scaledMachineCount.numerator);
    }
    return { scaleFactor, scaledMachineCounts };
  }

  let maxScaleFactor = getMaxScaleFactorForCaps(recipeMachines, perRecipeCaps);
  if (scaleFactor <= maxScaleFactor) {
    const scaledFactor = Rational.fromBigInt(scaleFactor);
    for (const [recipeId, exactMachineCount] of recipeMachines.entries()) {
      const scaledMachineCount = exactMachineCount.mul(scaledFactor);
      scaledMachineCounts.set(recipeId, scaledMachineCount.numerator);
    }
    return { scaleFactor, scaledMachineCounts };
  }

  scaleFactor = maxScaleFactor > 0n ? maxScaleFactor : 1n;
  const scaledFactor = Rational.fromBigInt(scaleFactor);
  for (const [recipeId, exactMachineCount] of recipeMachines.entries()) {
    const scaledExact = exactMachineCount.mul(scaledFactor);
    let rounded = roundRational(scaledExact);
    if (rounded < 1n) {
      rounded = 1n;
    }
    const recipeCap = perRecipeCaps?.get(recipeId);
    if (recipeCap !== undefined && rounded > recipeCap) {
      rounded = recipeCap;
    }
    scaledMachineCounts.set(recipeId, rounded);
  }

  return { scaleFactor, scaledMachineCounts };
}

function buildScaledExternalSources(
  catalog: Catalog,
  recipeSummaries: RecipePlanSummary[],
  dependencyGraph: Record<RecipeId, DependencyEdge[]>,
): ExternalSourceSummary[] {
  const scaledMap = new Map<ItemId, Rational>();
  const summaryByRecipeId = new Map(
    recipeSummaries.map((summary) => [summary.recipeId, summary]),
  );

  for (const [recipeId, edges] of Object.entries(dependencyGraph)) {
    const summary = summaryByRecipeId.get(recipeId);
    if (!summary) {
      continue;
    }
    for (const edge of edges) {
      if (edge.producerRecipeId) {
        continue;
      }
      const rate =
        summary.inputsPerSecond.find((input) => input.itemId === edge.itemId)?.rate ??
        Rational.zero();
      addToRateMap(scaledMap, edge.itemId, rate);
    }
  }

  return [...scaledMap.entries()].map(([itemId, scaledRate]) => ({
    itemId,
    itemName: getItemById(catalog, itemId)?.name ?? itemId,
    itemLabel: getCompactItemLabel(catalog, itemId),
    exactRate: Rational.zero(),
    scaledRate,
  }));
}

function buildItemNetRates(recipeSummaries: RecipePlanSummary[]): Record<ItemId, Rational> {
  const produced = new Map<ItemId, Rational>();
  const consumed = new Map<ItemId, Rational>();

  for (const summary of recipeSummaries) {
    for (const output of summary.outputsPerSecond) {
      addToRateMap(produced, output.itemId, output.rate);
    }
    for (const input of summary.inputsPerSecond) {
      addToRateMap(consumed, input.itemId, input.rate);
    }
  }

  const netRates: Record<ItemId, Rational> = {};
  const itemIds = new Set<ItemId>([...produced.keys(), ...consumed.keys()]);
  for (const itemId of itemIds) {
    const producedRate = produced.get(itemId) ?? Rational.zero();
    const consumedRate = consumed.get(itemId) ?? Rational.zero();
    netRates[itemId] = producedRate.sub(consumedRate);
  }

  return netRates;
}

function resolveProducer(
  catalog: Catalog,
  itemId: ItemId,
  selections: Record<ItemId, RecipeId>,
): Recipe | undefined {
  const available = getRecipeProducers(catalog, itemId);
  if (available.length === 0) {
    return undefined;
  }

  const selectedRecipeId = selections[itemId];
  if (selectedRecipeId) {
    const recipe = available.find((entry) => entry.id === selectedRecipeId);
    if (!recipe) {
      throw new PlannerError(`Selected recipe ${selectedRecipeId} does not produce ${itemId}.`);
    }
    return recipe;
  }

  if (available.length === 1) {
    return available[0];
  }

  throw new MissingRecipeSelectionError(
    itemId,
    available.map((recipe) => recipe.id),
  );
}

function detectCycles(
  catalog: Catalog,
  recipeId: RecipeId,
  selections: Record<ItemId, RecipeId>,
  stack: RecipeId[] = [],
  visiting = new Set<RecipeId>(),
  visited = new Set<RecipeId>(),
): void {
  if (visited.has(recipeId)) {
    return;
  }
  if (visiting.has(recipeId)) {
    const cycleStart = stack.indexOf(recipeId);
    throw new CycleDetectedError([...stack.slice(cycleStart), recipeId]);
  }

  const recipe = getRecipeById(catalog, recipeId);
  if (!recipe) {
    throw new PlannerError(`Unknown recipe id: ${recipeId}`);
  }

  visiting.add(recipeId);
  stack.push(recipeId);

  for (const input of recipe.inputs) {
    const producer = resolveProducer(catalog, input.itemId, selections);
    if (producer) {
      detectCycles(catalog, producer.id, selections, stack, visiting, visited);
    }
  }

  stack.pop();
  visiting.delete(recipeId);
  visited.add(recipeId);
}

function buildProcessRows(
  rootRecipeId: RecipeId,
  rootOutputItemId: ItemId | undefined,
  dependencyGraph: Record<RecipeId, DependencyEdge[]>,
  recipeSummaries: RecipePlanSummary[],
  externalSources: ExternalSourceSummary[],
): ProcessRow[] {
  const processRows: ProcessRow[] = [];
  const summaryByRecipeId = new Map(recipeSummaries.map((summary) => [summary.recipeId, summary]));
  const sourceByItemId = new Map(externalSources.map((source) => [source.itemId, source]));
  const visitedRecipes = new Set<string>();
  const visitedSources = new Set<ItemId>();

  const visitRecipe = (recipeId: RecipeId, displayItemId?: ItemId) => {
    const visitKey = `${recipeId}:${displayItemId ?? CONSUMPTION_LABEL}`;
    if (visitedRecipes.has(visitKey)) {
      return;
    }
    visitedRecipes.add(visitKey);

    const summary = summaryByRecipeId.get(recipeId);
    if (!summary) {
      return;
    }

    const mainOutput = displayItemId
      ? summary.outputsPerSecond.find((output) => output.itemId === displayItemId) ??
        summary.outputsPerSecond[0]
      : undefined;

    processRows.push({
      kind: "machine",
      recipeId: summary.recipeId,
      recipeName: summary.recipeName,
      machineName: summary.machineName,
      itemId: mainOutput?.itemId ?? `consumption:${summary.recipeId}`,
      itemLabel: mainOutput?.itemLabel ?? CONSUMPTION_LABEL,
      exactMachineCount: summary.exactMachineCount,
      scaledMachineCount: summary.scaledMachineCount,
      outputPerSecond: mainOutput?.rate ?? Rational.zero(),
      isConsumption: !mainOutput,
      byproducts: mainOutput
        ? summary.outputsPerSecond
            .filter((output) => output.itemId !== mainOutput.itemId)
            .map((output) => ({
              itemId: output.itemId,
              itemLabel: output.itemLabel,
              rate: output.rate,
            }))
        : [],
    });

    for (const edge of dependencyGraph[recipeId] ?? []) {
      if (edge.producerRecipeId) {
        visitRecipe(edge.producerRecipeId, edge.itemId);
        continue;
      }

      if (visitedSources.has(edge.itemId)) {
        continue;
      }

      const source = sourceByItemId.get(edge.itemId);
      if (!source) {
        continue;
      }

      visitedSources.add(edge.itemId);
      processRows.push({
        kind: "source",
        itemId: source.itemId,
        itemLabel: source.itemLabel,
        exactRate: source.exactRate,
        scaledRate: source.scaledRate,
      });
    }
  };

  visitRecipe(rootRecipeId, rootOutputItemId);
  return processRows;
}

export function planFactory(catalog: Catalog, request: PlannerRequest): PlannerResult {
  const catalogErrors = validateCatalog(catalog);
  if (catalogErrors.length > 0) {
    throw new PlannerError(catalogErrors[0]);
  }

  const rootRecipe = getRecipeById(catalog, request.rootRecipeId);
  if (!rootRecipe) {
    throw new PlannerError(`Unknown root recipe: ${request.rootRecipeId}`);
  }

  const rootOutputItemId = request.rootOutputItemId ?? rootRecipe.outputs[0]?.itemId;
  const isConsumptionPlan = !rootOutputItemId;

  if (!isConsumptionPlan && !getRecipeOutput(rootRecipe, rootOutputItemId)) {
    throw new PlannerError(
      `Root recipe ${rootRecipe.name} does not produce ${rootOutputItemId}.`,
    );
  }

  const targetValue = Rational.parse(request.targetValue);
  if (targetValue.compare(Rational.zero()) <= 0) {
    throw new PlannerError("Target value must be greater than zero.");
  }

  if (isConsumptionPlan && request.targetMode !== "machineCount") {
    throw new PlannerError("Consumption-only recipes can only be planned by machine count.");
  }

  const perRecipeCaps = request.perRecipeCaps
    ? (() => {
        const caps = new Map<RecipeId, bigint>();
        for (const [recipeId, rawValue] of Object.entries(request.perRecipeCaps)) {
          const trimmed = rawValue.trim();
          if (!trimmed) {
            continue;
          }
          const parsed = Rational.parse(trimmed);
          if (parsed.compare(Rational.zero()) <= 0 || parsed.denominator !== 1n) {
            throw new PlannerError("Per-recipe caps must be positive whole numbers.");
          }
          caps.set(recipeId, parsed.numerator);
        }
        return caps;
      })()
    : undefined;

  const resolvedSelections = { ...request.recipeSelections };
  detectCycles(catalog, rootRecipe.id, resolvedSelections);

  const recipeMachines = new Map<RecipeId, Rational>();
  const externalSources = new Map<ItemId, Rational>();
  const dependencyGraph = new Map<RecipeId, Map<ItemId, DependencyEdge>>();
  const frontier = new Map<ItemId, Rational>();

  const rootMachineCount =
    request.targetMode === "machineCount"
      ? targetValue
      : targetValue.div(getOutputRatePerMachine(rootRecipe, rootOutputItemId));

  addToMachineMap(recipeMachines, rootRecipe.id, rootMachineCount);
  dependencyGraph.set(rootRecipe.id, new Map<ItemId, DependencyEdge>());

  for (const input of rootRecipe.inputs) {
    const inputDemand = getAmountPerSecond(input.amount, rootRecipe.durationSec).mul(rootMachineCount);
    addToRateMap(frontier, input.itemId, inputDemand);
    const producer = resolveProducer(catalog, input.itemId, resolvedSelections);
    dependencyGraph.get(rootRecipe.id)?.set(input.itemId, {
      itemId: input.itemId,
      itemName: getItemById(catalog, input.itemId)?.name ?? input.itemId,
      producerRecipeId: producer?.id,
    });
    if (producer) {
      resolvedSelections[input.itemId] = producer.id;
    }
  }

  while (frontier.size > 0) {
    const nextFrontier = new Map<ItemId, Rational>();
    for (const [itemId, demandRate] of frontier.entries()) {
      const producer = resolveProducer(catalog, itemId, resolvedSelections);
      if (!producer) {
        addToRateMap(externalSources, itemId, demandRate);
        continue;
      }

      resolvedSelections[itemId] = producer.id;
      const machineCount = demandRate.div(getOutputRatePerMachine(producer, itemId));
      addToMachineMap(recipeMachines, producer.id, machineCount);

      if (!dependencyGraph.has(producer.id)) {
        dependencyGraph.set(producer.id, new Map<ItemId, DependencyEdge>());
      }

      for (const input of producer.inputs) {
        const inputRate = getInputRatePerMachine(producer, input.itemId).mul(machineCount);
        addToRateMap(nextFrontier, input.itemId, inputRate);
        const upstreamProducer = resolveProducer(catalog, input.itemId, resolvedSelections);
        dependencyGraph.get(producer.id)?.set(input.itemId, {
          itemId: input.itemId,
          itemName: getItemById(catalog, input.itemId)?.name ?? input.itemId,
          producerRecipeId: upstreamProducer?.id,
        });
        if (upstreamProducer) {
          resolvedSelections[input.itemId] = upstreamProducer.id;
        }
      }
    }

    frontier.clear();
    for (const [itemId, value] of nextFrontier.entries()) {
      frontier.set(itemId, value);
    }
  }

  if (perRecipeCaps) {
    for (const recipeId of perRecipeCaps.keys()) {
      if (!recipeMachines.has(recipeId)) {
        throw new PlannerError(`Cap recipe ${recipeId} is not part of this plan.`);
      }
    }
  }

  const { scaleFactor, scaledMachineCounts } = getScaledMachineCounts(
    recipeMachines,
    perRecipeCaps,
  );

  const recipeSummaries = [...recipeMachines.entries()].map(([recipeId, exactMachineCount]) => {
    const recipe = getRecipeById(catalog, recipeId);
    if (!recipe) {
      throw new PlannerError(`Unknown recipe id in result: ${recipeId}`);
    }

    const scaledMachineCount = scaledMachineCounts.get(recipeId) ?? 0n;
    return {
      recipeId,
      recipeName: recipe.name,
      machineName: recipe.machineName,
      exactMachineCount,
      scaledMachineCount,
      outputsPerSecond: recipe.outputs.map((output) => ({
        itemId: output.itemId,
        itemName: getItemById(catalog, output.itemId)?.name ?? output.itemId,
        itemLabel: getCompactItemLabel(catalog, output.itemId),
        rate: getAmountPerSecond(output.amount, recipe.durationSec).mul(
          Rational.fromBigInt(scaledMachineCount),
        ),
      })),
      inputsPerSecond: recipe.inputs.map((input) => ({
        itemId: input.itemId,
        itemName: getItemById(catalog, input.itemId)?.name ?? input.itemId,
        itemLabel: getCompactItemLabel(catalog, input.itemId),
        rate: getAmountPerSecond(input.amount, recipe.durationSec).mul(
          Rational.fromBigInt(scaledMachineCount),
        ),
      })),
    };
  });

  const serializedGraph: Record<RecipeId, DependencyEdge[]> = {};
  for (const [recipeId, edges] of dependencyGraph.entries()) {
    serializedGraph[recipeId] = [...edges.values()];
  }

  const scaledExternalSources = buildScaledExternalSources(
    catalog,
    recipeSummaries,
    serializedGraph,
  );
  const scaledExternalMap = new Map(
    scaledExternalSources.map((source) => [source.itemId, source.scaledRate]),
  );
  const externalSourceSummaries = [...externalSources.entries()].map(([itemId, exactRate]) => ({
    itemId,
    itemName: getItemById(catalog, itemId)?.name ?? itemId,
    itemLabel: getCompactItemLabel(catalog, itemId),
    exactRate,
    scaledRate: scaledExternalMap.get(itemId) ?? Rational.zero(),
  }));

  const rootScaledMachineCount = scaledMachineCounts.get(rootRecipe.id) ?? 0n;
  const itemNetRates = buildItemNetRates(recipeSummaries);

  return {
    rootRecipeId: rootRecipe.id,
    rootOutputItemId,
    rootOutputItemLabel: isConsumptionPlan
      ? CONSUMPTION_LABEL
      : getCompactItemLabel(catalog, rootOutputItemId),
    scaleFactor,
    achievedOutputPerSecond: isConsumptionPlan
      ? Rational.zero()
      : getOutputRatePerMachine(rootRecipe, rootOutputItemId)
          .mul(Rational.fromBigInt(rootScaledMachineCount)),
    itemNetRates,
    recipeSummaries,
    externalSources: externalSourceSummaries,
    dependencyGraph: serializedGraph,
    processRows: buildProcessRows(
      rootRecipe.id,
      isConsumptionPlan ? undefined : rootOutputItemId,
      serializedGraph,
      recipeSummaries,
      externalSourceSummaries,
    ),
    selections: resolvedSelections,
  };
}

export function formatRate(rate: Rational): string {
  return `${rate.toDecimalString(4)}/s (${rate.toFractionString()}/s)`;
}
