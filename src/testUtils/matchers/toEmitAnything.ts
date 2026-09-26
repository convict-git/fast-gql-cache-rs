// Copied from apollo-client-sm/src/testing/matchers/toEmitAnything.ts. Importing it from
// the submodule would pull @apollo/client/testing/internal's index, and with it React,
// into the typecheck; only the imports below differ.
import type { MatcherFunction } from "expect";

// Structural stand-ins for the submodule's ObservableStream types, which this copy
// cannot import (src/ is tsconfig.json's rootDir). They match
// apollo-client-sm/src/testing/internal/ObservableStream.ts.
interface TakeOptions {
  timeout?: number;
}

interface ObservableStream<T> {
  peek(options?: TakeOptions): Promise<T>;
}

export const toEmitAnything: MatcherFunction<[options?: TakeOptions]> =
  async function (actual, options) {
    const stream = actual as ObservableStream<any>;
    const hint = this.utils.matcherHint("toEmitAnything", "stream", "");

    try {
      const value = await stream.peek(options);

      return {
        pass: true,
        message: () => {
          return (
            hint +
            "\n\nExpected stream not to emit anything but it did." +
            "\n\nReceived:\n" +
            this.utils.printReceived(value)
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
            hint + "\n\nExpected stream to emit an event but it did not.",
        };
      } else {
        throw error;
      }
    }
  };
