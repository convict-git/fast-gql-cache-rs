import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = import.meta.dirname;
const apolloSm = join(rootDir, "apollo-client-sm");

export default {
  rootDir,
  preset: "ts-jest/presets/default-esm",
  watchman: false,
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: fileURLToPath(
    new URL("./apollo-client-sm/config/FixJSDOMEnvironment.js", import.meta.url)
  ),
  setupFilesAfterEnv: [],
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
