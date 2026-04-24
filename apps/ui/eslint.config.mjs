import nextConfig from "eslint-config-next";
import unusedImports from "eslint-plugin-unused-imports";

export default [
  { ignores: ["eslint.config.mjs", "postcss.config.mjs"] },
  ...nextConfig,
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "react-hooks/set-state-in-effect": "off",
    },
  },
];
