import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const apolloSm = join(rootDir, "apollo-client-sm");

export default {
  rootDir,
  preset: "ts-jest/presets/default-esm",
  watchman: false,
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: fileURLToPath(
    new URL("./apollo-client-sm/config/FixJSDOMEnvironment.js", import.meta.url)
  ),
  setupFilesAfterEnv: [join(rootDir, "config/jest/setup.ts")],
  testEnvironmentOptions: {
    url: "http://localhost",
  },
  snapshotFormat: {
    escapeString: true,
    printBasicPrototype: true,
  },
  transform: {
    "(\\.tsx?)$": [
      "ts-jest",
      {
        tsconfig: join(rootDir, "tsconfig.tests.json"),
        useESM: true,
      },
    ],
  },
  resolver: join(rootDir, "config/jest/resolver.cjs"),
  transformIgnorePatterns: ["/node_modules/(?!(rxjs)/)"],
  prettierPath: null,
  moduleNameMapper: {
    "^rxjs$": join(rootDir, "node_modules/rxjs/dist/cjs/index.js"),
    "^rxjs/ajax$": join(rootDir, "node_modules/rxjs/dist/cjs/ajax/index.js"),
    "^rxjs/fetch$": join(rootDir, "node_modules/rxjs/dist/cjs/fetch/index.js"),
    "^rxjs/operators$": join(
      rootDir,
      "node_modules/rxjs/dist/cjs/operators/index.js"
    ),
    "^rxjs/testing$": join(
      rootDir,
      "node_modules/rxjs/dist/cjs/testing/index.js"
    ),
    "^rxjs/webSocket$": join(
      rootDir,
      "node_modules/rxjs/dist/cjs/webSocket/index.js"
    ),
    "^rxjs/internal/(.*)$": join(
      rootDir,
      "node_modules/rxjs/dist/cjs/internal/$1.js"
    ),
    "^@apollo/client/testing/internal$": join(
      apolloSm,
      "src/testing/internal/index.ts"
    ),
    "^(\\.\\./)+pkg/fast_gql_cache_rs\\.js$": join(
      rootDir,
      "pkg/fast_gql_cache_rs.cjs"
    ),
  },
  testMatch: ["<rootDir>/src/**/__tests__/**/*.ts"],
  testPathIgnorePatterns: ["/src/__tests__/spyOnConsole\\.ts$"],
};
