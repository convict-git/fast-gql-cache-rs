import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsRules = {
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
};

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "pkg/**",
      "coverage/**",
      "apollo-client-sm/**",
      ".cursor/skills/rust-skills/**",
      "node_modules/**",
    ],
  },
  // Library sources are covered by tsconfig.json, so they can use the
  // type-aware project service. Tests live outside that project (tsconfig.json
  // excludes __tests__), so they are handled by the untyped block below.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: tsRules,
  },
  // Test and TypeScript tooling files (not part of the library tsconfig). Test
  // files are adapted copies of Apollo's own suite, so preset style rules that
  // fight the vendored source are relaxed here while the library sources above
  // stay strict.
  {
    files: ["src/**/__tests__/**/*.ts", "config/**/*.ts", "*.config.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.jest },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "prefer-const": "off",
      "prefer-rest-params": "off",
    },
  },
  // ESM tooling/config files.
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // CommonJS tooling/config files.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.commonjs },
    },
  }
);
