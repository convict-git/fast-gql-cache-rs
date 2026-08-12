import type { MatcherHintOptions } from "jest-matcher-utils";

declare global {
  namespace jest {
    interface Matchers<R> {
      toStrictEqualTyped(
        expected: any,
        options?: {
          received?: string;
          expected?: string;
          hintOptions?: MatcherHintOptions;
        }
      ): R;
    }
  }
}

export {};

