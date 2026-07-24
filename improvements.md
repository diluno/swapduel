# Swapduel — Improvement Ideas (vs. Panel de Pon)

Prioritized list of gameplay and feel improvements toward the SNES original.
Engine references are in `packages/game-engine/src/`.

## 1. The big one: swap while things are falling

### 1.1 Swap during resolution

The engine uses a board-wide phase machine — any clear anywhere freezes the
whole board, and `panelCanSwap` requires idle state (`simulation.ts:53`).
In Panel de Pon, panels resolve independently and you can keep swapping while
other panels flash, pop, and fall. That freedom is the basis of advanced play
(setting up the next chain link *during* the current pop) and is the single
largest gap between "matching game" and "Panel de Pon."

Requires moving from `phase: ResolutionPhase` on the board to per-panel
timers. Big refactor, biggest payoff.

## 2. High-impact, moderate effort

### 2.1 Garbage telegraph queue — ✅ done
Attacks currently insert only when the receiving board is fully idle
(`simulation.ts:695-704`), with no visible warning. Classic PdP shows queued
garbage icons above the board and drops it after a short delay, mid-play.
The visible queue builds versus tension and gives the defender a fair window
to chain in response.

### 2.2 Reward manual raise instead of punishing it — ✅ done (bonus attack not taken)
Raising currently destroys stop time (`simulation.ts:722-724`) and is blocked
in danger. SNES rewards raising. At minimum:
- Don't wipe stop time on raise; allow raising during stop (consume it faster).
- Consider a small attack or tempo bonus for aggressive raising.

### 2.3 Shape-aware combo garbage — ✅ done
The combo table is flat 1-high by count (`config.ts:38-96`). SNES sends e.g.
+4 as 3-wide, +5 as 4-wide, +6 as full-width, and >6 as multiple staggered
blocks. Bigger combos become visibly scarier on the opponent's board.

### 2.4 Visible stop-time indicator — ✅ done
Stop time accumulates but is never shown. Add a draining bar or flashing
"STOP" timer near the rise meter so players can tell why the stack paused.

## 3. Feel / juice (cheap wins)

### 3.1 Panic escalation — ✅ done
No music; danger is a lone beep (`useGameAudio.ts:209-222`). Layer a rising
pulse/heartbeat as the stack nears the top, tint the board or shake slightly
in danger. The danger state machine already exists to hook into.

### 3.2 Screen shake + landing feedback — ✅ done
Garbage slabs landing with a thud, small shake, and squash animation is one
of Tetris Attack's most memorable sensations. Particles and badges exist, but
no shake or squash.

### 3.3 Cursor model — ✅ done
Tap-select works on mobile, but an optional visible 2-wide cursor with
keyboard/swipe control enables much faster play and is instantly
recognizable. (Vertical swaps don't exist in PdP — correctly omitted.)

### 3.4 Sequential pop timing — ✅ done
Panels in a clear should pop one at a time (each ~100 ms after the previous)
with individual pings. The ascending audio arpeggio is close; the *visual*
stagger is the signature of the original.

## 4. Smaller authenticity touches

- **4.1 Skill stop in danger:** in SNES, a match in flight while topped out
  extends the grace timer; the current danger timer only freezes during
  resolution (`danger.ts:31-69`) — close, but doesn't reward last-second
  saves the same way.
- **4.2 Chain garbage height curve:** currently `columns × (level-1)`
  (`attacks.ts:49-51`); SNES chain garbage is always full-width with
  height = chain level − 1. Cap it and stagger multiple slabs for monster
  chains in versus.
- **4.3 Scoring / solo mode:** round-wins-only is fine for duels, but a classic
  point table (combos/chains) would enable an endless/score-attack solo
  mode — a big fun multiplier when no opponent is around, and a training
  ground for chains.

## Top three picks

1. ~~**2.1** Garbage telegraph queue (contained change)~~ — done
2. **1.1** Swap-during-resolution (deep refactor)
3. ~~**3.2 + 3.1** Landing shake + panic audio (contained change)~~ — done
