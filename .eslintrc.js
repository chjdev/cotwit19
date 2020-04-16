module.exports = {
  root: true,
  plugins: ["prettier", "import", "jsdoc"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2018, // Allows for the parsing of modern ECMAScript features
    sourceType: "module", // Allows for the use of imports
  },
  extends: [
    "plugin:prettier/recommended",
    "plugin:@typescript-eslint/recommended", // Uses the recommended rules from @typescript-eslint/eslint-plugin
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "plugin:import/recommended",
    "prettier/@typescript-eslint",
    "plugin:jsdoc/recommended",
  ],
  rules: {
    "@typescript-eslint/no-namespace": "off",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-inferrable-types": "off",
    "@typescript-eslint/explicit-member-accessibility": ["error"],
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-use-before-define": ["error", { classes: false }],
    "@typescript-eslint/no-empty-function": "warn",
    "@typescript-eslint/no-empty-interface": [
      "error",
      {
        allowSingleExtends: true,
      },
    ],
    "prettier/prettier": "error",
    "no-restricted-syntax": [
      "error",
      {
        selector: "ExportDefaultDeclaration",
        message: "Prefer named exports",
      },
    ],
    "import/no-unassigned-import": "warn",
    "jsdoc/no-types": "warn",
    "jsdoc/require-param-type": "off",
    "jsdoc/require-returns-type": "off",
    "jsdoc/require-property-type": "off",
    // off for now while adding docs
    "jsdoc/require-jsdoc": ["off", {
        "require": {
            "FunctionDeclaration": true,
            "MethodDefinition": true,
            "ClassDeclaration": true,
            "ArrowFunctionExpression": true,
            "FunctionExpression": true
        }
    }],
    // companion objects
    "import/export": "off",
  },
};
