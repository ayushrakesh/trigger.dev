/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  future: {
    v2_dev: true,
    v2_routeConvention: true,
    v2_normalizeFormMethod: true,
    v2_errorBoundary: true,
    // v2_meta: true,
  },
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  devServerPort: 8002,
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    "marked",
    "axios",
    "@trigger.dev/core",
    "@trigger.dev/sdk",
    "emails",
    "highlight.run",
    "random-words",
  ],
  watchPaths: async () => {
    return [
      "../../packages/core/src/**/*",
      "../../packages/trigger-sdk/src/**/*",
      "../../packages/emails/src/**/*",
    ];
  },
};
