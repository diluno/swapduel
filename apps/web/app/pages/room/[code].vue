<script setup lang="ts">
import type { PlayerSession } from '@swapduel/contracts'

const route = useRoute()
const requestUrl = useRequestURL()
const code = computed(() =>
  String(route.params.code ?? '').trim().toUpperCase(),
)
const displayName = ref('')
const busy = ref(false)
const shareMessage = ref('')
const {
  connected,
  roomState,
  session,
  roundPreparation,
  errorMessage,
  joinRoom,
  setReady,
  startMatch,
  getSavedDisplayName,
} = useRoomSocket()

const activeRoom = computed(() =>
  roomState.value?.roomCode === code.value ? roomState.value : null,
)
const currentPlayer = computed(() =>
  activeRoom.value?.players.find(
    ({ playerId }) => playerId === session.value?.playerId,
  ),
)
const slots = computed(() =>
  ([1, 2] as const).map(
    (slot) =>
      activeRoom.value?.players.find(
        (player) => player.slot === slot,
      ) ?? null,
  ),
)
const invitationUrl = computed(
  () => `${requestUrl.origin}/room/${code.value}`,
)
const bothPlayersReady = computed(
  () =>
    activeRoom.value?.players.length === 2 &&
    activeRoom.value.players.every(
      (player) => player.connected && player.ready,
    ),
)
const isHost = computed(
  () => currentPlayer.value?.playerId === activeRoom.value?.hostPlayerId,
)

useHead({
  title: computed(() => `Room ${code.value} · Swapduel`),
})

onMounted(() => {
  displayName.value = getSavedDisplayName()
})

watch(
  roundPreparation,
  async (preparation) => {
    if (
      preparation !== null &&
      preparation.roomId === activeRoom.value?.roomId
    ) {
      await navigateTo(`/match/${preparation.matchId}`)
    }
  },
  { immediate: true },
)

async function joinThisRoom(): Promise<void> {
  busy.value = true
  await joinRoom(code.value, displayName.value)
  busy.value = false
}

async function toggleReady(): Promise<void> {
  if (currentPlayer.value === undefined) return
  busy.value = true
  await setReady(!currentPlayer.value.ready)
  busy.value = false
}

async function beginMatch(): Promise<void> {
  busy.value = true
  await startMatch()
  busy.value = false
}

async function shareInvitation(): Promise<void> {
  shareMessage.value = ''
  if (navigator.share !== undefined) {
    try {
      await navigator.share({
        title: 'Play Swapduel with me',
        text: `Join my Swapduel room ${code.value}`,
        url: invitationUrl.value,
      })
      shareMessage.value = 'Invitation shared'
      return
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
    }
  }

  try {
    await navigator.clipboard.writeText(invitationUrl.value)
    shareMessage.value = 'Invitation link copied'
  } catch {
    shareMessage.value = 'Select and copy the invitation link'
  }
}

function playerStatus(player: PlayerSession): string {
  if (!player.connected) return 'Disconnected'
  return player.ready ? 'Ready' : 'Not ready'
}
</script>

<template>
  <main class="room-shell">
    <section v-if="activeRoom === null" class="join-card">
      <p class="kicker">Private match</p>
      <h1>Join room <span>{{ code }}</span></h1>
      <p class="sub">
        Choose the name your opponent will see in the waiting room.
      </p>

      <form @submit.prevent="joinThisRoom">
        <label>
          <span>Your name</span>
          <input
            v-model="displayName"
            maxlength="20"
            autocomplete="nickname"
            placeholder="Peachy player"
            required
          >
        </label>
        <button type="submit" :disabled="busy">
          {{ busy ? 'Joining…' : 'Join match' }}
        </button>
      </form>

      <p v-if="errorMessage" class="error-message" role="alert">
        {{ errorMessage }}
      </p>
      <NuxtLink to="/">Back home</NuxtLink>
    </section>

    <section v-else class="waiting-card">
      <header>
        <div>
          <p class="kicker">Waiting room</p>
          <h1>Room <span>{{ activeRoom.roomCode }}</span></h1>
        </div>
        <span class="connection-pill">
          <i :class="{ online: connected }" />
          {{ connected ? 'Connected' : 'Reconnecting' }}
        </span>
      </header>

      <div class="invite">
        <div>
          <span>Invitation link</span>
          <strong>{{ invitationUrl }}</strong>
        </div>
        <button type="button" @click="shareInvitation">Share</button>
      </div>
      <p class="share-message" aria-live="polite">{{ shareMessage }}</p>

      <div class="format-pill">First to 2 rounds</div>

      <ol class="player-list">
        <li
          v-for="(player, index) in slots"
          :key="player?.playerId ?? `empty-${index}`"
          :class="{ empty: player === null }"
        >
          <span class="slot-number">{{ index + 1 }}</span>
          <div>
            <strong>
              {{ player?.displayName ?? 'Waiting for a friend…' }}
              <small
                v-if="player?.playerId === activeRoom.hostPlayerId"
              >
                Host
              </small>
              <small v-if="player?.playerId === session?.playerId">
                You
              </small>
            </strong>
            <span v-if="player !== null">{{ playerStatus(player) }}</span>
            <span v-else>Share the code to fill this slot</span>
          </div>
          <i
            class="ready-dot"
            :class="{
              ready: player?.ready,
              disconnected: player !== null && !player.connected,
            }"
          />
        </li>
      </ol>

      <button
        class="ready-button"
        type="button"
        :disabled="busy || !connected"
        @click="toggleReady"
      >
        {{ currentPlayer?.ready ? 'Not ready yet' : 'I’m ready' }}
      </button>

      <button
        v-if="isHost"
        class="start-button"
        type="button"
        :disabled="busy || !connected || !bothPlayersReady"
        @click="beginMatch"
      >
        Start match
      </button>

      <p class="waiting-status" aria-live="polite">
        {{
          bothPlayersReady
            ? isHost
              ? 'Both players are ready. Start when you are set.'
              : 'Both players are ready. Waiting for the host.'
            : 'The match can start when both players are ready.'
        }}
      </p>
      <p v-if="errorMessage" class="error-message" role="alert">
        {{ errorMessage }}
      </p>
    </section>
  </main>
</template>

<style scoped>
.room-shell {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding:
    max(24px, env(safe-area-inset-top))
    max(16px, env(safe-area-inset-right))
    max(28px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
}

.join-card,
.waiting-card {
  width: min(100%, 520px);
  padding: clamp(24px, 7vw, 36px);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 14px 38px rgba(120, 80, 50, 0.13);
}

.kicker {
  margin: 0 0 5px;
  color: #c99b82;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-size: clamp(1.8rem, 8vw, 2.5rem);
  font-weight: 600;
}

h1 span {
  color: #ff7e54;
  letter-spacing: 0.06em;
}

.sub {
  margin: 12px 0 22px;
  color: #a38b7c;
  font-weight: 600;
  line-height: 1.55;
}

.join-card form,
.join-card label {
  display: grid;
  gap: 8px;
}

.join-card label span,
.invite span {
  color: #c99b82;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

input {
  width: 100%;
  min-height: 50px;
  padding: 0 16px;
  border: 2px solid #f5e3d3;
  border-radius: 16px;
  outline: 0;
  background: #fffaf5;
  color: #6e5648;
  font-weight: 700;
}

input:focus {
  border-color: #ffb59a;
  box-shadow: 0 0 0 3px rgba(255, 181, 154, 0.2);
}

.join-card form button,
.start-button {
  min-height: 60px;
  margin-top: 8px;
  border: 0;
  border-radius: 32px;
  background: linear-gradient(180deg, #ff9a6e 0%, #ff7e54 60%, #f26a40 100%);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.12),
    0 6px 0 #d95832,
    0 12px 18px rgba(217, 88, 50, 0.27);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1.05rem;
  font-weight: 600;
}

button:disabled {
  cursor: wait;
  filter: saturate(0.45);
  opacity: 0.62;
}

.join-card > a {
  display: inline-block;
  min-height: 44px;
  margin-top: 14px;
  padding-top: 12px;
  color: #bc8e72;
  font-size: 0.8rem;
  font-weight: 800;
}

.waiting-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.connection-pill,
.format-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border-radius: 24px;
  background: #fff4e8;
  color: #bc8e72;
  font-size: 0.72rem;
  font-weight: 800;
}

.connection-pill {
  min-height: 38px;
  padding: 0 13px;
  white-space: nowrap;
}

.connection-pill i,
.ready-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #c9b4a5;
}

.connection-pill i.online,
.ready-dot.ready {
  background: #5fd0a0;
  box-shadow: 0 0 0 3px rgba(95, 208, 160, 0.16);
}

.invite {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 24px;
  padding: 13px 13px 13px 16px;
  border-radius: 18px;
  background: #fff4e8;
}

.invite div {
  min-width: 0;
  flex: 1;
}

.invite span,
.invite strong {
  display: block;
}

.invite strong {
  overflow: hidden;
  margin-top: 3px;
  color: #7a6557;
  font-size: 0.77rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.invite button {
  min-width: 76px;
  min-height: 44px;
  border: 1px solid #f3dfcf;
  border-radius: 23px;
  background: #fff;
  color: #bc8e72;
  font-weight: 800;
}

.share-message {
  min-height: 1.2em;
  margin: 7px 4px 0;
  color: #5baf88;
  font-size: 0.72rem;
  font-weight: 800;
}

.format-pill {
  margin-top: 12px;
  padding: 9px 16px;
}

.player-list {
  display: grid;
  gap: 10px;
  margin: 18px 0;
  padding: 0;
  list-style: none;
}

.player-list li {
  display: grid;
  grid-template-columns: 42px 1fr 12px;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 12px 16px 12px 12px;
  border: 1px solid #f5e3d3;
  border-radius: 20px;
  background: #fffaf5;
}

.player-list li.empty {
  border-style: dashed;
  background: rgba(255, 244, 232, 0.56);
}

.slot-number {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 14px;
  background: linear-gradient(180deg, #ffcf5c 55%, #f4b637);
  box-shadow:
    inset 0 3px 0 rgba(255, 255, 255, 0.5),
    inset 0 -4px 0 rgba(110, 86, 72, 0.1),
    0 3px 7px rgba(110, 86, 72, 0.13);
  color: #fff;
  font-family: "Fredoka", sans-serif;
  font-size: 1.05rem;
  font-weight: 600;
}

.player-list strong,
.player-list div > span {
  display: block;
}

.player-list strong {
  color: #6e5648;
  font-family: "Fredoka", sans-serif;
  font-weight: 600;
}

.player-list small {
  display: inline-block;
  margin-left: 4px;
  padding: 2px 7px;
  border-radius: 10px;
  background: #ffead6;
  color: #bc8e72;
  font-family: "Nunito", sans-serif;
  font-size: 0.6rem;
  font-weight: 800;
  text-transform: uppercase;
  vertical-align: 2px;
}

.player-list div > span {
  margin-top: 2px;
  color: #a38b7c;
  font-size: 0.73rem;
  font-weight: 700;
}

.ready-dot.disconnected {
  background: #f0606c;
}

.ready-button {
  width: 100%;
  min-height: 52px;
  border: 1px solid #f3dfcf;
  border-radius: 27px;
  background: #fff4e8;
  color: #7a6557;
  font-family: "Fredoka", sans-serif;
  font-size: 1rem;
  font-weight: 600;
}

.start-button {
  width: 100%;
  margin-top: 12px;
}

.waiting-status {
  margin: 18px 0 0;
  color: #a38b7c;
  font-size: 0.8rem;
  font-weight: 700;
  text-align: center;
}

.error-message {
  margin: 14px 0 0;
  color: #f0606c;
  font-size: 0.82rem;
  font-weight: 800;
}

@media (max-width: 430px) {
  .waiting-card header {
    display: block;
  }

  .connection-pill {
    margin-top: 10px;
  }
}
</style>
