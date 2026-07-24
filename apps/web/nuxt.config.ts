export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  css: ['~/assets/css/main.css'],
  modules: [],
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
