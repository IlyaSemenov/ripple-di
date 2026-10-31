import { defineConfig } from "vitepress"

export default defineConfig({
  title: "Ripple DI",
  description: "Scoped dependency injection for TypeScript",
  // Served from https://ilyasemenov.github.io/ripple-di/
  base: "/ripple-di/",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [{ text: "Docs", link: "/getting-started" }],
    sidebar: [
      { text: "Getting Started", link: "/getting-started" },
      { text: "Dependencies", link: "/dependencies" },
      { text: "Overrides", link: "/overrides" },
      { text: "Value Lifetime", link: "/lifetime" },
      { text: "Application Wiring", link: "/application" },
      { text: "Testing", link: "/testing" },
      {
        text: "Advanced",
        items: [
          { text: "Factory Dependencies", link: "/factory-dependencies" },
          { text: "Explicit Scopes", link: "/scopes" },
          { text: "Background Work", link: "/background-work" },
          { text: "Reusable Overrides", link: "/reusable-overrides" },
          { text: "Memoized Members", link: "/memo" },
          { text: "Multiple Runtimes", link: "/runtimes" },
          { text: "Several Package Copies", link: "/package-copies" },
        ],
      },
      { text: "Errors", link: "/errors" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/IlyaSemenov/ripple-di/edit/main/docs/:path",
    },
    socialLinks: [{ icon: "github", link: "https://github.com/IlyaSemenov/ripple-di" }],
  },
})
