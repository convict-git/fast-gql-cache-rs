const possibleExtensions = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Jest resolver shim (CJS).
 *
 * Jest loads custom resolvers via `require(...)`, so this file must be CommonJS.
 * We mainly need Apollo's behavior of allowing `.js` specifiers to resolve to
 * `.ts` sources in the repo/submodule during tests.
 */
exports.sync = function sync(request, options) {
  const resolver = options.defaultResolver;

  if (request.startsWith(".") && request.endsWith(".js")) {
    for (const extension of possibleExtensions) {
      try {
        return resolver(request.replace(/\.js$/i, extension), options);
      } catch {
        // Try the next extension.
      }
    }
  }

  return resolver(request, options);
};
