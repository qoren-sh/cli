import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Mirrors dashboard/eslint.config.js's TypeScript rules, minus the Next.js and
// React parts this package has no use for. Type-checked linting is on: the SDK
// is the contract every client reads, so an unsound cast here is a bug in more
// than one place.
export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  {
    // Typed rules need a program, so they apply only to the sources that are in
    // one. This config file itself is plain ESM and is deliberately left out.
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Same rule deltas as dashboard/eslint.config.js. They have to match: the
    // DTO types are shared code, and a rule this package enforced but the
    // dashboard did not would make moving a type between them a rewrite.
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
    },
  },
);
