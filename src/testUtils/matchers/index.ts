import { toBeOneOf } from "./toBeOneOf.js";
import { toEmitAnything } from "./toEmitAnything.js";
import { toEmitTypedValue } from "./toEmitTypedValue.js";
import { toStrictEqualTyped } from "./toStrictEqualTyped.js";

expect.extend({
  toBeOneOf,
  toEmitAnything,
  toEmitTypedValue,
  toStrictEqualTyped,
});
