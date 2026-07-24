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
  modules: [],
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
