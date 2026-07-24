<script setup lang="ts">
const isDevelopment = import.meta.dev

useHead({
  title: 'Swapduel',
  meta: [
    {
      name: 'description',
      content: 'A fast, mobile-first rising-stack puzzle duel.',
    },
  ],
})
</script>

<template>
  <main class="home">
    <section class="hero">
      <span class="decor-panel decor-panel--berry" aria-hidden="true">♥</span>
      <span class="decor-panel decor-panel--mint" aria-hidden="true">○</span>
      <span class="sparkle sparkle--top" aria-hidden="true">✦</span>
      <span class="sparkle sparkle--bottom" aria-hidden="true">✦</span>
      <p class="eyebrow">Private puzzle battles</p>
      <h1>Swapduel</h1>
      <p class="intro">
        Build chains, send trouble, and keep your stack below the line.
      </p>
      <div class="notice">
        <strong>Engine prototype underway.</strong>
        Private rooms will arrive after the offline mechanics are complete.
      </div>
      <NuxtLink v-if="isDevelopment" class="lab-link" to="/lab">
        Open game laboratory
      </NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.home {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding:
    max(24px, env(safe-area-inset-top))
    max(20px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom))
    max(20px, env(safe-area-inset-left));
}

.hero {
  position: relative;
  width: min(100%, 440px);
  padding: clamp(32px, 8vw, 52px) clamp(24px, 7vw, 44px);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 14px 38px rgba(120, 80, 50, 0.13);
  text-align: center;
}

.eyebrow {
  margin: 0 0 10px;
  color: #c99b82;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: #ff7e54;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(3rem, 16vw, 4.7rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  text-shadow:
    0 3px 0 #fff,
    0 5px 0 #e9c9b2,
    0 10px 18px rgba(196, 120, 80, 0.22);
}

.intro {
  max-width: 21rem;
  margin: 24px auto 20px;
  color: #7a6557;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.6;
}

.notice {
  padding: 17px 18px;
  border-radius: 18px;
  background: #fff4e8;
  color: #a38b7c;
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.55;
}

.notice strong {
  display: block;
  color: #6e5648;
  font-weight: 800;
}

.lab-link {
  display: grid;
  min-height: 60px;
  margin-top: 20px;
  place-items: center;
  border-radius: 32px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.12),
    0 6px 0 #d95832,
    0 12px 18px rgba(217, 88, 50, 0.3);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1.1rem;
  font-weight: 600;
  text-decoration: none;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}

.lab-link:active {
  transform: translateY(3px);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.45),
    inset 0 -3px 0 rgba(110, 86, 72, 0.1),
    0 3px 0 #d95832,
    0 7px 12px rgba(217, 88, 50, 0.24);
}

.decor-panel {
  position: absolute;
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  border-radius: 15px;
  color: rgba(255, 255, 255, 0.92);
  font-family: "Fredoka", sans-serif;
  font-size: 1.4rem;
  font-weight: 700;
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.1),
    0 4px 8px rgba(110, 86, 72, 0.16);
}

.decor-panel--berry {
  top: -18px;
  left: 22px;
  background: linear-gradient(180deg, #ff7c86 55%, #f0606c);
  transform: rotate(-12deg);
}

.decor-panel--mint {
  right: 20px;
  bottom: -19px;
  background: linear-gradient(180deg, #5fd0a0 55%, #3fba87);
  font-size: 1.8rem;
  transform: rotate(10deg);
}

.sparkle {
  position: absolute;
  color: #ffcf5c;
  font-size: 1.3rem;
  line-height: 1;
}

.sparkle--top {
  top: 18px;
  right: 28px;
}

.sparkle--bottom {
  bottom: 26px;
  left: 14px;
  color: #b79bf0;
  font-size: 0.9rem;
}

@media (prefers-reduced-motion: reduce) {
  .lab-link {
    transition: none;
  }
}
</style>
