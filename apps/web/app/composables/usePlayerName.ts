export const DISPLAY_NAME_STORAGE_KEY = 'swapduel:display-name'

/**
 * The name a player last used, shared by the multiplayer lobby and the
 * leaderboard. Kept out of `useRoomSocket` so a page can read or remember a
 * name without opening a socket connection.
 */
export function usePlayerName() {
  function readPlayerName(): string {
    if (!import.meta.client) return ''
    try {
      return localStorage.getItem(DISPLAY_NAME_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  }

  function rememberPlayerName(displayName: string): void {
    if (!import.meta.client) return
    try {
      localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName)
    } catch {
      // A blocked write only costs the convenience of a prefilled field.
    }
  }

  return { readPlayerName, rememberPlayerName }
}
