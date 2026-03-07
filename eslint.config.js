import path from "node:path";
import { fileURLToPath } from "node:url";

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ["coverage", "dist", "node_modules"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"]
    }
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off"
    }
  }
);
