import { Rational } from "./rational";
import { RecipeAmount } from "./types";

export function parseRecipeAmount(amount: RecipeAmount): Rational {
  if (typeof amount === "bigint") {
    return Rational.fromBigInt(amount);
  }

  return Rational.parse(amount.trim());
}

export function formatRecipeAmount(amount: RecipeAmount): string {
  return typeof amount === "bigint" ? amount.toString() : amount.trim();
}
