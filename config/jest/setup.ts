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

