// Copied from apollo-client-sm/src/testing/matchers/toEmitTypedValue.ts. Importing it
// from the submodule would pull @apollo/client/testing/internal's index, and with it
// React, into the typecheck; only the imports below differ.
import { iterableEquality } from "@jest/expect-utils";
import type { MatcherFunction } from "expect";
import type { MatcherHintOptions } from "jest-matcher-utils";

import { getSerializableProperties } from "./utils/getSerializableProperties.js";

// Structural stand-ins for the submodule's ObservableStream types, which this copy
// cannot import (src/ is tsconfig.json's rootDir). They match
// apollo-client-sm/src/testing/internal/ObservableStream.ts.
interface TakeOptions {
  timeout?: number;
}

interface ObservableStream<T> {
  takeNext(options?: TakeOptions): Promise<T>;
}

const EventMismatchError = {
  is(
    error: unknown
  ): error is Error & { formatMessage(matcherName: string): string } {
    return error instanceof Error && error.name === "EventMismatchError";
  },
};

export const toEmitTypedValue: MatcherFunction<
  [
    value: any,
    options?: TakeOptions & {
      received?: string;
      expected?: string;
      hintOptions?: MatcherHintOptions;
    },
  ]
> = async function (actual, expected, options) {
  const stream = actual as ObservableStream<any>;
  const hint = this.utils.matcherHint(
    this.isNot ? ".not.toEmitTypedValue" : "toEmitTypedValue",
    options?.received || "stream",
    options?.expected || "expected",
    { ...options?.hintOptions, isNot: this.isNot }
  );

  try {
    const value = await stream.takeNext(options);
    const serializableProperties = getSerializableProperties(value);

    const pass = this.equals(
      serializableProperties,
      expected,
      // https://github.com/jestjs/jest/blob/22029ba06b69716699254bb9397f2b3bc7b3cf3b/packages/expect/src/matchers.ts#L62-L67
      [...this.customTesters, iterableEquality],
      true
    );

    return {
      pass,
      message: () => {
        if (pass) {
          return (
            hint +
            "\n\nExpected stream not to emit a fetch result equal to expected but it did."
          );
        }

        return (
          hint +
          "\n\n" +
          this.utils.printDiffOrStringify(
            expected,
            serializableProperties,
            "Expected",
            "Received",
            true
          )
        );
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Timeout waiting for next event"
    ) {
      return {
        pass: false,
        message: () =>
          hint + "\n\nExpected stream to emit a value but it did not.",
      };
    } else if (EventMismatchError.is(error)) {
      return {
        pass: false,
        message: () => error.formatMessage("toEmitTypedValue"),
      };
    } else {
      throw error;
    }
  }
};
