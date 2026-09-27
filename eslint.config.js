import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      // Money-handling rule: token amounts must never pass through
      // Number()/parseFloat() — precision loss on atomic-unit integers is
      // the exact bug class this repo forbids. Any legitimate exception
      // (none expected for amounts) requires an explicit disable comment.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='Number']",
          message: "Number() is banned in src/: use BigInt / integer strings for all amounts.",
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "parseFloat() is banned in src/: use parseDecimalToAtomic() from amount.ts.",
        },
        {
          selector: "CallExpression[callee.name='parseInt']",
          message: "parseInt() is banned in src/: use BigInt / integer strings for all amounts.",
        },
      ],
    },
  },
  {
    ignores: ["dist/", "debug/", "examples/", "node_modules/"],
  },
);
