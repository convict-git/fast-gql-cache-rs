// Imported first by setup.ts. ES module imports are hoisted and evaluated in order, so
// an assignment in setup.ts's body would run only after every import there, including
// any that load @apollo/client and read __DEV__ (the matchers do).
// @ts-ignore
globalThis.__DEV__ = true;
