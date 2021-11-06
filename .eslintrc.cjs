module.exports = {
    root: true,
    parser: "@typescript-eslint/parser",
    parserOptions: {
        ecmaVersion: 12,
        sourceType: "module",
        tsconfigRootDir: __dirname,
        project: ['./tsconfig.json']
    },
    plugins: [
        '@typescript-eslint'
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:@typescript-eslint/recommended-requiring-type-checking'
    ],
    rules: {
        "indent": "off",
        "semi": "off",
        "@typescript-eslint/semi": "warn",
        "@typescript-eslint/indent": "warn",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
        "@typescript-eslint/unbound-method": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/restrict-template-expressions": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/explicit-module-boundary-types": "off",
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-unused-vars": [
            "warn", {
                "args": "all",
                "argsIgnorePattern": "^_"
            }
        ]
    }
}