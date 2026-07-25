<script setup lang="ts">
const isDevelopment = import.meta.dev
const playerName = ref('')
const roomCode = ref('')
const busy = ref(false)
const {
  connected,
  errorMessage,
  createRoom,
  joinRoom,
  getSavedDisplayName,
} = useRoomSocket()

useHead({
  title: 'Swapduel',
  meta: [
    {
      name: 'description',
      content: 'A fast, mobile-first rising-stack puzzle duel.',
    },
  ],
})

onMounted(() => {
  playerName.value = getSavedDisplayName()
})

async function createPrivateMatch(): Promise<void> {
  busy.value = true
  const session = await createRoom(playerName.value)
  busy.value = false
  if (session !== null) {
    await navigateTo(`/room/${session.roomState.roomCode}`)
  }
}

async function joinPrivateMatch(): Promise<void> {
  busy.value = true
  const session = await joinRoom(roomCode.value, playerName.value)
  busy.value = false
  if (session !== null) {
    await navigateTo(`/room/${session.roomState.roomCode}`)
  }
}
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
      <form class="match-form" @submit.prevent="createPrivateMatch">
        <label>
          <span>Your name</span>
          <input
            v-model="playerName"
            name="displayName"
            maxlength="20"
            autocomplete="nickname"
            required
          >
        </label>

        <button class="primary-action" type="submit" :disabled="busy">
          {{ busy ? 'Connecting…' : 'Create private match' }}
        </button>

        <div class="divider"><span>or play alone</span></div>

        <NuxtLink class="secondary-action secondary-action--link" to="/solo">
          Endless score attack
        </NuxtLink>

        <div class="divider"><span>or join a friend</span></div>

        <label>
          <span>Room code</span>
          <input
            v-model="roomCode"
            class="code-input"
            name="roomCode"
            maxlength="6"
            autocapitalize="characters"
            autocomplete="off"
            placeholder="K7M4DP"
          >
        </label>

        <button
          class="secondary-action"
          type="button"
          :disabled="busy"
          @click="joinPrivateMatch"
        >
          Join match
        </button>
      </form>

      <p v-if="errorMessage" class="form-message" role="alert">
        {{ errorMessage }}
      </p>
      <p class="connection-status" aria-live="polite">
        <span :class="{ online: connected }" />
        {{ connected ? 'Game server connected' : 'Connecting to game server…' }}
      </p>

      <p class="instructions">
        No account needed. Create a room, share its six-character code, and
        challenge one friend.
      </p>

      <NuxtLink v-if="isDevelopment" class="lab-link" to="/lab">
        Open the board laboratory
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

.match-form {
  display: grid;
  gap: 12px;
  text-align: left;
}

.match-form label {
  display: grid;
  gap: 6px;
}

.match-form label span {
  color: #c99b82;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.match-form input {
  width: 100%;
  min-height: 50px;
  padding: 0 16px;
  border: 2px solid #f5e3d3;
  border-radius: 16px;
  outline: 0;
  background: #fffaf5;
  color: #6e5648;
  font-size: 1rem;
  font-weight: 700;
}

.match-form input:focus {
  border-color: #ffb59a;
  box-shadow: 0 0 0 3px rgba(255, 181, 154, 0.2);
}

.code-input {
  font-family: "Fredoka", sans-serif;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}

.primary-action,
.secondary-action {
  width: 100%;
  border: 0;
  font-family: "Fredoka", sans-serif;
  cursor: pointer;
}

.primary-action {
  min-height: 60px;
  margin-top: 4px;
  border-radius: 32px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.12),
    0 6px 0 #d95832,
    0 12px 18px rgba(217, 88, 50, 0.3);
  color: #fff;
  font-size: 1.08rem;
  font-weight: 600;
}

.secondary-action {
  min-height: 50px;
  border: 1px solid #f3dfcf;
  border-radius: 26px;
  background: #fff4e8;
  box-shadow:
    inset 0 2px 0 rgba(255, 255, 255, 0.9),
    0 3px 7px rgba(110, 86, 72, 0.09);
  color: #7a6557;
  font-weight: 600;
}

/* The same pill rendered as a link: an anchor stays inline, so it needs the
   box and centring a button gets for free. */
.secondary-action--link {
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}

.primary-action:disabled,
.secondary-action:disabled {
  cursor: wait;
  opacity: 0.62;
}

.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 0;
  color: #c9b4a5;
  font-size: 0.72rem;
  font-weight: 800;
  text-transform: uppercase;
}

.divider::before,
.divider::after {
  height: 1px;
  flex: 1;
  background: #f5e3d3;
  content: "";
}

.form-message {
  margin: 14px 0 0;
  color: #f0606c;
  font-size: 0.85rem;
  font-weight: 800;
}

.connection-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 16px 0 0;
  color: #bc8e72;
  font-size: 0.72rem;
  font-weight: 800;
}

.connection-status span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c9b4a5;
}

.connection-status span.online {
  background: #5fd0a0;
  box-shadow: 0 0 0 3px rgba(95, 208, 160, 0.16);
}

.instructions {
  margin: 16px 0 0;
  color: #a38b7c;
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.5;
}

.lab-link {
  display: inline-block;
  min-height: 44px;
  padding-top: 14px;
  color: #bc8e72;
  font-size: 0.78rem;
  font-weight: 800;
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

</style>
