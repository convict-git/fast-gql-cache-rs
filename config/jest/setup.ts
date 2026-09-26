import "./dev.js";

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

import gql from "graphql-tag";
import { setLogVerbosity } from "@apollo/client";

// Apollo's own equality testers, as registered by apollo-client-sm/src/config/jest/setup.ts.
// Without them Jest compares these errors loosely (a MissingFieldError by message only,
// ignoring its path, query, variables and missing tree).
import { areCombinedGraphQLErrorsEqual } from "../../apollo-client-sm/src/config/jest/areCombinedGraphQLErrorsEqual.js";
import { areCombinedProtocolErrorsEqual } from "../../apollo-client-sm/src/config/jest/areCombinedProtocolErrorsEqual.js";
import { areGraphQLErrorsEqual } from "../../apollo-client-sm/src/config/jest/areGraphQlErrorsEqual.js";
import { areLocalStateErrorsEqual } from "../../apollo-client-sm/src/config/jest/areLocalStateErrorsEqual.js";
import { areMissingFieldErrorsEqual } from "../../apollo-client-sm/src/config/jest/areMissingFieldErrorsEqual.js";
import { areServerErrorsEqual } from "../../apollo-client-sm/src/config/jest/areServerErrorsEqual.js";
import { areWeakRefsEqual } from "../../apollo-client-sm/src/config/jest/areWeakRefsEqual.js";

import {
  loadDevMessages,
  loadErrorMessageHandler,
  loadErrorMessages,
} from "@apollo/client/dev";

// Ensure Apollo emits full (non-minified) message text in tests.
loadDevMessages();
loadErrorMessages();
loadErrorMessageHandler();

// As in Apollo's setup: log verbosity, no repeated-fragment-name warnings, and its
// equality testers.
setLogVerbosity("log");
gql.disableFragmentWarnings();
expect.addEqualityTesters([
  areServerErrorsEqual,
  areCombinedGraphQLErrorsEqual,
  areCombinedProtocolErrorsEqual,
  areGraphQLErrorsEqual,
  areLocalStateErrorsEqual,
  areMissingFieldErrorsEqual,
  areWeakRefsEqual,
]);

// not available in JSDOM
global.structuredClone = (val) => JSON.parse(JSON.stringify(val));
