export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      socketUrl:
        process.env.NUXT_PUBLIC_SOCKET_URL ??
        (process.env.NODE_ENV === 'production'
          ? ''
          : 'http://localhost:3001'),
    },
  },
  modules: ['@nuxt/icon'],
  icon: {
    // Solar ships as a local @iconify-json package and the icons we use are
    // bundled into the client build, so nothing is fetched from the Iconify
    // API at runtime — the game stays offline-friendly and there is no
    // first-paint pop-in on the toggles.
    mode: 'svg',
    provider: 'none',
    // Belt and braces with `provider: 'none'`: never reach for the Iconify API
    // at runtime. A name that was not bundled renders empty rather than
    // silently pulling from the network on someone's mobile connection.
    fallbackToApi: false,
    // Write icon names as static `name` attributes (v-if between two <Icon>s
    // rather than a `:name` ternary) — the scanner reads the source text, and
    // with `provider: 'none'` an unscanned name renders as an empty svg.
    clientBundle: { scan: true },
  },
  nitro: {
    prerender: {
      ignore: ['/lab'],
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
  vite: {
    optimizeDeps: {
      exclude: ['@swapduel/game-engine'],
    },
  },
})
