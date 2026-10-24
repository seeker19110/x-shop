import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.medusa/**",
      "**/coverage/**",
      ".xtemplates/**",
      ".claude/**",
      "**/*.config.{js,mjs,cjs}",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Tiền là số nguyên VND (BASE-DATA-005)." },
      ],
    },
  },
);
