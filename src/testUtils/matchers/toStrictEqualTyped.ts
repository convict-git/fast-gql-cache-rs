import { iterableEquality } from "@jest/expect-utils";
import type { MatcherFunction } from "expect";
import type { MatcherHintOptions } from "jest-matcher-utils";

export const toStrictEqualTyped: MatcherFunction<
  [
    value: any,
    options?: {
      received?: string;
      expected?: string;
      hintOptions?: MatcherHintOptions;
    },
  ]
> = function (actual, expected, options = {}) {
  const hint = this.utils.matcherHint(
    this.isNot ? ".not.toStrictEqualTyped" : "toStrictEqualTyped",
    options?.received || "value",
    options?.expected || "expected",
    { ...options.hintOptions, isNot: this.isNot, promise: this.promise }
  );

  const pass = this.equals(
    actual,
    expected,
    // Align with Jest's strict equality semantics for iterables.
    [...this.customTesters, iterableEquality],
    true
  );

  return {
    pass,
    message: () => {
      if (pass) {
        return hint + `\n\nExpected: not ${this.utils.printExpected(expected)}`;
      }

      return (
        hint +
        "\n\n" +
        this.utils.printDiffOrStringify(
          expected,
          actual,
          "Expected",
          "Received",
          true
        )
      );
    },
  };
};

