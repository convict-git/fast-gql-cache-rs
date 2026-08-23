// @ts-ignore
globalThis.__DEV__ = true;

import { jest as jestGlobals } from "@jest/globals";
import { TextDecoder, TextEncoder } from "util";

global.TextEncoder ??= TextEncoder;
// @ts-ignore
global.TextDecoder ??= TextDecoder;

// Make the `jest` global available in ESM tests.
// @ts-ignore
globalThis.jest ??= jestGlobals;

// jsdom runs in a separate realm where `Symbol.dispose`/`Symbol.asyncDispose`
// may be missing; the downleveled `using` helper needs them (mirrors Apollo's
// own jest setup at apollo-client-sm/src/config/jest/setup.ts).
if (!Symbol.dispose) {
  Object.defineProperty(Symbol, "dispose", {
    value: Symbol("dispose"),
  });
}
if (!Symbol.asyncDispose) {
  Object.defineProperty(Symbol, "asyncDispose", {
    value: Symbol("asyncDispose"),
  });
}

import "@testing-library/jest-dom";
import "../../src/testUtils/matchers/index.js";

import {
  loadDevMessages,
  loadErrorMessageHandler,
  loadErrorMessages,
} from "@apollo/client/dev";

// Ensure Apollo emits full (non-minified) message text in tests.
loadDevMessages();
loadErrorMessages();
loadErrorMessageHandler();

// not available in JSDOM
global.structuredClone = (val) => JSON.parse(JSON.stringify(val));

