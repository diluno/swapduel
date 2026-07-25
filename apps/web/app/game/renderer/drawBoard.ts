import {
  defaultGameConfig,
  type GarbageBlock,
  type PanelType,
  type SimulationState,
} from '@swapduel/game-engine'
import {
  SQUASH_DURATION_MS,
  panelFallVisual,
  shakeOffset,
  type ImpactState,
} from './impact'

const PANEL_COLORS: Record<
  PanelType,
  { top: string; bottom: string }
> = {
  heart: { top: '#ff7c86', bottom: '#f0606c' },
  circle: { top: '#5fd0a0', bottom: '#3fba87' },
  diamond: { top: '#6bb6f2', bottom: '#4c9ee3' },
  star: { top: '#ffcf5c', bottom: '#f4b637' },
  triangle: { top: '#b79bf0', bottom: '#9e7fe6' },
  crescent: { top: '#ffb59a', bottom: '#ed6a45' },
  shock: { top: '#fffaf5', bottom: '#ffd8b8' },
}

const COMBO_EFFECT_DURATION_MS = 1_100
/** How long a panel freed from a garbage block plays its break-out flash. */
const GARBAGE_REVEAL_MS = 190

interface DrawBoardOptions {
  selected: { row: number; column: number } | null
  /** Two-wide keyboard cursor; `column` is its left cell. */
  cursor?: { row: number; column: number } | null
  reducedMotion: boolean
  /** Landing shake + squash bookkeeping; omit to draw a perfectly still board. */
  impact?: ImpactState | null
  /** 0..1 panic escalation as the stack nears the top. */
  panic?: number
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function drawPanelSurface(
  context: CanvasRenderingContext2D,
  panelType: PanelType,
  x: number,
  y: number,
  size: number,
  inset: number,
  popping = false,
): void {
  const colors = PANEL_COLORS[panelType]
  const tileX = x + inset
  const tileY = y + inset
  const tileSize = size - inset * 2
  const radius = tileSize * 0.3

  context.save()
  roundedRect(context, tileX, tileY, tileSize, tileSize, radius)
  context.clip()

  if (popping) {
    context.fillStyle = '#fffaf5'
    context.fillRect(tileX, tileY, tileSize, tileSize)
  } else {
    const gradient = context.createLinearGradient(
      tileX,
      tileY,
      tileX,
      tileY + tileSize,
    )
    gradient.addColorStop(0, colors.top)
    gradient.addColorStop(0.55, colors.top)
    gradient.addColorStop(1, colors.bottom)
    context.fillStyle = gradient
    context.fillRect(tileX, tileY, tileSize, tileSize)

    context.fillStyle = 'rgba(255, 255, 255, 0.46)'
    context.fillRect(
      tileX + tileSize * 0.17,
      tileY + tileSize * 0.07,
      tileSize * 0.66,
      Math.max(2, tileSize * 0.065),
    )
    context.fillStyle = 'rgba(110, 86, 72, 0.1)'
    context.fillRect(
      tileX,
      tileY + tileSize * 0.88,
      tileSize,
      tileSize * 0.12,
    )
  }

  context.restore()
  roundedRect(context, tileX, tileY, tileSize, tileSize, radius)
  context.strokeStyle = 'rgba(255, 255, 255, 0.52)'
  context.lineWidth = Math.max(1, size * 0.025)
  context.stroke()
}

function drawSymbol(
  context: CanvasRenderingContext2D,
  panelType: PanelType,
  centerX: number,
  centerY: number,
  size: number,
): void {
  context.save()
  const symbolColor =
    panelType === 'shock' ? '#ed6a45' : 'rgba(255, 255, 255, 0.92)'
  context.strokeStyle = symbolColor
  context.fillStyle = symbolColor
  context.lineWidth = Math.max(2, size * 0.075)
  context.lineCap = 'round'
  context.lineJoin = 'round'

  if (panelType === 'circle') {
    context.beginPath()
    context.arc(centerX, centerY, size * 0.18, 0, Math.PI * 2)
    context.stroke()
  } else if (panelType === 'triangle') {
    context.beginPath()
    context.moveTo(centerX, centerY - size * 0.22)
    context.lineTo(centerX + size * 0.22, centerY + size * 0.18)
    context.lineTo(centerX - size * 0.22, centerY + size * 0.18)
    context.closePath()
    context.stroke()
  } else if (panelType === 'star') {
    context.beginPath()
    for (let point = 0; point < 10; point += 1) {
      const radius = point % 2 === 0 ? size * 0.23 : size * 0.1
      const angle = -Math.PI / 2 + (point * Math.PI) / 5
      const x = centerX + Math.cos(angle) * radius
      const y = centerY + Math.sin(angle) * radius
      if (point === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.closePath()
    context.fill()
  } else if (panelType === 'diamond') {
    context.beginPath()
    context.moveTo(centerX, centerY - size * 0.24)
    context.lineTo(centerX + size * 0.2, centerY)
    context.lineTo(centerX, centerY + size * 0.24)
    context.lineTo(centerX - size * 0.2, centerY)
    context.closePath()
    context.stroke()
  } else if (panelType === 'heart') {
    context.font = `800 ${size * 0.48}px system-ui`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('♥', centerX, centerY + size * 0.02)
  } else if (panelType === 'crescent') {
    context.beginPath()
    context.arc(
      centerX - size * 0.02,
      centerY,
      size * 0.2,
      -Math.PI * 0.42,
      Math.PI * 0.42,
    )
    context.stroke()
  } else if (panelType === 'shock') {
    context.font = `900 ${size * 0.46}px system-ui`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('ϟ', centerX, centerY)
  }

  context.restore()
}

// Panels are the hot path: up to 72 of them redrawn every frame, each
// otherwise costing a clip(), a freshly allocated gradient and a handful of
// paths. Their appearance only depends on (type, variant, cellSize, dpr), so
// each combination is rasterised once into a small offscreen canvas and the
// per-frame work collapses to a single drawImage.
type PanelSpriteVariant = 'idle' | 'flashing' | 'incoming'

const PANEL_SPRITE_VARIANTS: readonly PanelSpriteVariant[] = [
  'idle',
  'flashing',
  'incoming',
]

interface PanelSpriteSheet {
  signature: string
  padding: number
  size: number
  sprites: Map<string, HTMLCanvasElement>
}

let panelSpriteSheet: PanelSpriteSheet | null = null

function renderPanelSprite(
  panelType: PanelType,
  variant: PanelSpriteVariant,
  cellSize: number,
  padding: number,
  dpr: number,
): HTMLCanvasElement {
  const size = cellSize + padding * 2
  const sprite = document.createElement('canvas')
  sprite.width = Math.max(1, Math.round(size * dpr))
  sprite.height = Math.max(1, Math.round(size * dpr))

  const context = sprite.getContext('2d')
  if (context === null) return sprite
  context.setTransform(dpr, 0, 0, dpr, 0, 0)

  const inset = cellSize * 0.075
  const centerX = padding + cellSize / 2
  const centerY = padding + cellSize / 2

  // Mirrors the per-variant state the immediate-mode path used to set on the
  // board context before drawing a panel.
  if (variant === 'flashing') {
    context.shadowColor = PANEL_COLORS[panelType].top
    context.shadowBlur = cellSize * 0.25
  } else if (variant === 'incoming') {
    context.filter = 'saturate(0.7)'
    context.shadowColor = PANEL_COLORS[panelType].bottom
    context.shadowBlur = cellSize * 0.08
  }

  drawPanelSurface(
    context,
    panelType,
    padding,
    padding,
    cellSize,
    inset,
    variant === 'flashing',
  )
  // A flashing panel is a solid white pop with no symbol on top.
  if (variant !== 'flashing') {
    drawSymbol(context, panelType, centerX, centerY, cellSize)
  }

  return sprite
}

function panelSpritesFor(
  cellSize: number,
  dpr: number,
): PanelSpriteSheet {
  const signature = `${cellSize.toFixed(3)}|${dpr}`
  if (panelSpriteSheet !== null && panelSpriteSheet.signature === signature) {
    return panelSpriteSheet
  }

  // Enough room for the widest glow (flashing, blur = cellSize * 0.25).
  const padding = Math.ceil(cellSize * 0.35)
  const sprites = new Map<string, HTMLCanvasElement>()
  for (const panelType of Object.keys(PANEL_COLORS) as PanelType[]) {
    for (const variant of PANEL_SPRITE_VARIANTS) {
      sprites.set(
        `${panelType}|${variant}`,
        renderPanelSprite(panelType, variant, cellSize, padding, dpr),
      )
    }
  }

  panelSpriteSheet = {
    signature,
    padding,
    size: cellSize + padding * 2,
    sprites,
  }
  return panelSpriteSheet
}

function drawPanelSprite(
  context: CanvasRenderingContext2D,
  sheet: PanelSpriteSheet,
  panelType: PanelType,
  variant: PanelSpriteVariant,
  x: number,
  y: number,
): void {
  const sprite = sheet.sprites.get(`${panelType}|${variant}`)
  if (sprite === undefined) return
  context.drawImage(
    sprite,
    x - sheet.padding,
    y - sheet.padding,
    sheet.size,
    sheet.size,
  )
}

interface GarbageSkin {
  mortar: string
  tileTop: string
  tileMid: string
  tileBottom: string
  rim: string
  shade: string
  mark: string
  shadow: string
}

const GARBAGE_SKINS: Record<GarbageBlock['type'], GarbageSkin> = {
  normal: {
    mortar: '#a3806a',
    tileTop: '#f0dccb',
    tileMid: '#dcc0aa',
    tileBottom: '#c29f86',
    rim: 'rgba(255, 250, 245, 0.8)',
    shade: 'rgba(110, 78, 61, 0.18)',
    mark: 'rgba(120, 84, 62, 0.42)',
    shadow: 'rgba(110, 74, 54, 0.26)',
  },
  metal: {
    mortar: '#5d8098',
    tileTop: '#e9f3f9',
    tileMid: '#bcd2e0',
    tileBottom: '#94b4c7',
    rim: 'rgba(248, 253, 255, 0.88)',
    shade: 'rgba(48, 82, 106, 0.2)',
    mark: 'rgba(58, 92, 116, 0.45)',
    shadow: 'rgba(66, 112, 143, 0.3)',
  },
}

// One cell of a slab, drawn as its own rounded brick so a block reads as a
// wall of tiles in the same visual language as the panels it sits on, rather
// than one flat sheet with seams scratched into it.
function drawGarbageTile(
  context: CanvasRenderingContext2D,
  skin: GarbageSkin,
  isMetal: boolean,
  x: number,
  y: number,
  cellSize: number,
  heat: number,
): void {
  const inset = cellSize * 0.055
  const tileX = x + inset
  const tileY = y + inset
  const size = cellSize - inset * 2
  const radius = cellSize * 0.19

  context.save()
  roundedRect(context, tileX, tileY, size, size, radius)
  context.clip()

  const face = context.createLinearGradient(tileX, tileY, tileX, tileY + size)
  face.addColorStop(0, skin.tileTop)
  face.addColorStop(0.55, skin.tileMid)
  face.addColorStop(1, skin.tileBottom)
  context.fillStyle = face
  context.fillRect(tileX, tileY, size, size)

  // Bevel: a bright lip along the top, a soft shadow pooling at the bottom.
  context.fillStyle = 'rgba(255, 255, 255, 0.5)'
  context.fillRect(tileX, tileY, size, Math.max(1.5, size * 0.14))
  context.fillStyle = skin.shade
  context.fillRect(tileX, tileY + size * 0.82, size, size * 0.18)

  if (isMetal) {
    context.strokeStyle = 'rgba(255, 255, 255, 0.26)'
    context.lineWidth = Math.max(1.5, cellSize * 0.07)
    context.beginPath()
    context.moveTo(tileX - size * 0.1, tileY + size * 0.78)
    context.lineTo(tileX + size * 0.72, tileY - size * 0.1)
    context.stroke()
  }

  if (heat > 0) {
    context.fillStyle = `rgba(255, 252, 246, ${0.72 * heat})`
    context.fillRect(tileX, tileY, size, size)
  }
  context.restore()

  // Centre mark: a rivet on metal, an embossed lozenge on the soft blocks.
  const centerX = x + cellSize / 2
  const centerY = y + cellSize / 2
  context.save()
  context.globalAlpha = Math.max(0, 1 - heat)
  if (isMetal) {
    context.beginPath()
    context.arc(centerX, centerY, cellSize * 0.072, 0, Math.PI * 2)
    context.fillStyle = '#eef6fb'
    context.fill()
    context.strokeStyle = skin.mark
    context.lineWidth = Math.max(1, cellSize * 0.022)
    context.stroke()
  } else {
    const mark = cellSize * 0.1
    context.beginPath()
    context.moveTo(centerX, centerY - mark)
    context.lineTo(centerX + mark, centerY)
    context.lineTo(centerX, centerY + mark)
    context.lineTo(centerX - mark, centerY)
    context.closePath()
    context.fillStyle = 'rgba(255, 249, 242, 0.7)'
    context.fill()
    context.strokeStyle = skin.mark
    context.lineWidth = Math.max(1, cellSize * 0.022)
    context.stroke()
  }
  context.restore()

  roundedRect(context, tileX, tileY, size, size, radius)
  context.strokeStyle = skin.rim
  context.lineWidth = Math.max(1, cellSize * 0.03)
  context.stroke()
}

// Jagged fractures across a tile that is about to give way.
function drawTileCracks(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellSize: number,
  seed: number,
  alpha: number,
): void {
  context.save()
  context.strokeStyle = `rgba(255, 252, 246, ${alpha})`
  context.lineWidth = Math.max(1.5, cellSize * 0.04)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  const centerX = x + cellSize / 2
  const centerY = y + cellSize / 2
  for (let arm = 0; arm < 4; arm += 1) {
    const angle = ((seed * 37 + arm * 120) % 360) * (Math.PI / 180)
    context.beginPath()
    context.moveTo(centerX, centerY)
    context.lineTo(
      centerX + Math.cos(angle) * cellSize * 0.2,
      centerY + Math.sin(angle) * cellSize * 0.2,
    )
    context.lineTo(
      centerX + Math.cos(angle + 0.5) * cellSize * 0.36,
      centerY + Math.sin(angle + 0.5) * cellSize * 0.36,
    )
    context.stroke()
  }
  context.restore()
}

function drawGarbageBlock(
  context: CanvasRenderingContext2D,
  block: GarbageBlock,
  x: number,
  y: number,
  width: number,
  height: number,
  cellSize: number,
  reducedMotion: boolean,
  elapsedMs: number,
): void {
  const isMetal = block.type === 'metal'
  const skin = GARBAGE_SKINS[block.type]
  const inset = cellSize * 0.03
  const bodyX = x + inset
  const bodyY = y + inset
  const bodyWidth = width - inset * 2
  const bodyHeight = height - inset * 2
  const radius = cellSize * 0.22
  const converting = block.state === 'converting'
  // The whole slab throbs while it is breaking up, so the row coming apart is
  // never the first hint that the block is going.
  const pulse = reducedMotion
    ? 0.5
    : (1 + Math.sin(elapsedMs / 65)) / 2

  context.save()

  // Mortar body, offset downward so the tiles sit in a lit recess.
  context.shadowColor = skin.shadow
  context.shadowBlur =
    block.state === 'falling' ? cellSize * 0.24 : cellSize * 0.11
  context.shadowOffsetY =
    block.state === 'falling' ? cellSize * 0.1 : cellSize * 0.05
  roundedRect(context, bodyX, bodyY, bodyWidth, bodyHeight, radius)
  context.fillStyle = skin.mortar
  context.fill()
  context.shadowColor = 'transparent'

  const conversionVisualRow = block.height - 1
  for (let row = 0; row < block.height; row += 1) {
    for (let column = 0; column < block.width; column += 1) {
      const tileX = x + column * cellSize
      const tileY = y + row * cellSize
      const breaking = converting && row === conversionVisualRow
      const heat = breaking ? 0.25 + 0.4 * pulse : converting ? 0.1 * pulse : 0
      drawGarbageTile(
        context,
        skin,
        isMetal,
        tileX,
        tileY,
        cellSize,
        heat,
      )
      if (breaking) {
        drawTileCracks(
          context,
          tileX,
          tileY,
          cellSize,
          column + block.id,
          0.45 + 0.4 * pulse,
        )
      }
    }
  }

  roundedRect(context, bodyX, bodyY, bodyWidth, bodyHeight, radius)
  context.strokeStyle = skin.rim
  context.lineWidth = Math.max(1.5, cellSize * 0.035)
  context.stroke()

  if (converting) {
    // A hot seam runs along the row that is about to be handed over.
    const seamY = y + conversionVisualRow * cellSize
    context.save()
    roundedRect(context, bodyX, bodyY, bodyWidth, bodyHeight, radius)
    context.clip()
    const seam = context.createLinearGradient(0, seamY, 0, seamY + cellSize)
    seam.addColorStop(0, `rgba(255, 236, 196, ${0.1 + 0.16 * pulse})`)
    seam.addColorStop(1, `rgba(255, 209, 92, ${0.3 + 0.32 * pulse})`)
    context.fillStyle = seam
    context.fillRect(x, seamY, width, cellSize)
    context.restore()
  }

  if (block.state === 'falling' && !reducedMotion) {
    context.strokeStyle = isMetal
      ? 'rgba(78, 120, 150, 0.32)'
      : 'rgba(110, 86, 72, 0.28)'
    context.lineWidth = Math.max(1.5, cellSize * 0.035)
    context.lineCap = 'round'
    for (const position of [0.25, 0.5, 0.75]) {
      const motionX = bodyX + bodyWidth * position
      context.beginPath()
      context.moveTo(motionX, bodyY - cellSize * 0.16)
      context.lineTo(motionX, bodyY - cellSize * 0.04)
      context.stroke()
    }
  }
  context.restore()
}

function drawComboEffect(
  context: CanvasRenderingContext2D,
  state: SimulationState,
  cssWidth: number,
  cssHeight: number,
  cellSize: number,
  reducedMotion: boolean,
): void {
  const clear = state.lastClearEvent
  if (clear === null || clear.normalSize < 4) return

  const age = state.elapsedMs - clear.occurredAt
  if (age < 0 || age >= COMBO_EFFECT_DURATION_MS) return

  const fade =
    age < 760
      ? 1
      : Math.max(
          0,
          1 - (age - 760) / (COMBO_EFFECT_DURATION_MS - 760),
        )
  const burstProgress = Math.min(1, age / 720)
  const enterProgress = Math.min(1, age / 220)
  const overshoot = enterProgress - 1
  const entranceScale = reducedMotion
    ? 1
    : 1 +
      2.70158 * overshoot ** 3 +
      1.70158 * overshoot ** 2
  const sizeBoost = Math.min(0.12, (clear.normalSize - 4) * 0.018)
  const scale = entranceScale * (1 + sizeBoost)
  const centerX = cssWidth / 2
  const centerY = Math.max(cellSize * 1.45, cssHeight * 0.28)
  const palette =
    clear.normalSize >= 8
      ? { top: '#b79bf0', bottom: '#6b8fe8', shadow: '#7459ba' }
      : clear.normalSize >= 6
        ? { top: '#ff8f91', bottom: '#ed6a45', shadow: '#c6533a' }
        : { top: '#ffd15c', bottom: '#ff914f', shadow: '#d87828' }

  context.save()
  context.globalAlpha = fade
  context.translate(centerX, centerY)

  if (!reducedMotion) {
    const ringRadius = cellSize * (0.62 + burstProgress * 1.08)
    context.beginPath()
    context.arc(0, 0, ringRadius, 0, Math.PI * 2)
    context.strokeStyle =
      clear.normalSize >= 8
        ? `rgba(183, 155, 240, ${0.5 * (1 - burstProgress)})`
        : `rgba(255, 207, 92, ${0.58 * (1 - burstProgress)})`
    context.lineWidth = Math.max(2, cellSize * 0.08)
    context.stroke()

    const particleCount = Math.min(14, clear.normalSize + 4)
    const particleColors = [
      '#ffcf5c',
      '#ff8c66',
      '#ff7c86',
      '#5fd0a0',
      '#6bb6f2',
      '#b79bf0',
    ]
    for (let particle = 0; particle < particleCount; particle += 1) {
      const angle =
        -Math.PI / 2 + (particle / particleCount) * Math.PI * 2
      const stagger = (particle % 3) * cellSize * 0.08
      const distance =
        cellSize * (0.54 + burstProgress * 1.16) + stagger
      const particleX = Math.cos(angle) * distance
      const particleY = Math.sin(angle) * distance
      const particleSize =
        cellSize * (0.075 - burstProgress * 0.025)

      context.save()
      context.globalAlpha =
        fade * Math.max(0, 1 - burstProgress * 0.78)
      context.translate(particleX, particleY)
      context.rotate(angle + burstProgress * Math.PI)
      context.fillStyle =
        particleColors[particle % particleColors.length]!
      if (particle % 2 === 0) {
        context.fillRect(
          -particleSize / 2,
          -particleSize / 2,
          particleSize,
          particleSize,
        )
      } else {
        context.beginPath()
        context.arc(0, 0, particleSize / 2, 0, Math.PI * 2)
        context.fill()
      }
      context.restore()
    }
  }

  context.scale(scale, scale)
  const badgeWidth = Math.min(
    cssWidth * 0.68,
    Math.max(142, cellSize * 3.65),
  )
  const badgeHeight = Math.max(42, cellSize * 0.72)
  const badgeX = -badgeWidth / 2
  const badgeY = -badgeHeight / 2
  const badgeRadius = badgeHeight / 2

  context.shadowColor = 'rgba(110, 70, 48, 0.26)'
  context.shadowBlur = cellSize * 0.2
  context.shadowOffsetY = cellSize * 0.1
  roundedRect(
    context,
    badgeX,
    badgeY + cellSize * 0.075,
    badgeWidth,
    badgeHeight,
    badgeRadius,
  )
  context.fillStyle = palette.shadow
  context.fill()

  roundedRect(
    context,
    badgeX,
    badgeY,
    badgeWidth,
    badgeHeight,
    badgeRadius,
  )
  const badgeGradient = context.createLinearGradient(
    0,
    badgeY,
    0,
    badgeY + badgeHeight,
  )
  badgeGradient.addColorStop(0, palette.top)
  badgeGradient.addColorStop(0.58, palette.top)
  badgeGradient.addColorStop(1, palette.bottom)
  context.fillStyle = badgeGradient
  context.fill()
  context.shadowColor = 'transparent'

  roundedRect(
    context,
    badgeX + cellSize * 0.035,
    badgeY + cellSize * 0.035,
    badgeWidth - cellSize * 0.07,
    badgeHeight - cellSize * 0.07,
    badgeRadius,
  )
  context.strokeStyle = 'rgba(255, 255, 255, 0.72)'
  context.lineWidth = Math.max(1.5, cellSize * 0.035)
  context.stroke()

  context.fillStyle = '#fff'
  context.font = `700 ${Math.max(17, cellSize * 0.38)}px "Fredoka", system-ui`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.shadowColor = 'rgba(110, 70, 48, 0.32)'
  context.shadowBlur = 0
  context.shadowOffsetY = Math.max(1, cellSize * 0.035)
  context.fillText(
    `${clear.normalSize} COMBO!`,
    0,
    cellSize * 0.015,
  )
  context.restore()
}

// Panels of a clear pop one at a time, top row first and left to right within
// a row — the reading order the SNES uses. The engine holds each group for
// exactly this long (see clearPhaseDurationMs), so the stagger is real rather
// than a renderer illusion. Groups are counted separately: two clears running
// side by side each start their own stagger from one.
function popOrder(state: SimulationState): Map<number, number> {
  const byId = new Map<number, { id: number; row: number; column: number }>()
  for (const row of state.board.cells) {
    for (const panel of row) {
      if (panel !== null) byId.set(panel.id, panel)
    }
  }

  const order = new Map<number, number>()
  for (const group of state.clears) {
    const matched = group.panelIds
      .map((id) => byId.get(id))
      .filter((panel): panel is { id: number; row: number; column: number } =>
        panel !== undefined,
      )
      .sort((a, b) => b.row - a.row || a.column - b.column)
    matched.forEach((panel, index) => order.set(panel.id, index))
  }
  return order
}

// The board goes redder and breathes faster the closer the stack gets to the
// top, so danger is legible from peripheral vision alone.
function drawPanicTint(
  context: CanvasRenderingContext2D,
  panic: number,
  elapsedMs: number,
  cssWidth: number,
  cssHeight: number,
  cellSize: number,
  reducedMotion: boolean,
): void {
  if (panic <= 0.02) return

  // 0.9 Hz when the stack first gets uncomfortable, ~2.4 Hz at the top.
  const pulseHz = 0.9 + panic * 1.5
  const pulse = reducedMotion
    ? 0.5
    : (1 - Math.cos((elapsedMs / 1_000) * pulseHz * Math.PI * 2)) / 2
  const strength = panic * (0.45 + pulse * 0.55)

  context.save()
  const vignette = context.createLinearGradient(0, 0, 0, cssHeight)
  vignette.addColorStop(0, `rgba(240, 96, 108, ${0.3 * strength})`)
  vignette.addColorStop(0.45, `rgba(240, 96, 108, ${0.09 * strength})`)
  vignette.addColorStop(1, `rgba(240, 96, 108, ${0.03 * strength})`)
  context.fillStyle = vignette
  context.fillRect(0, 0, cssWidth, cssHeight)

  context.strokeStyle = `rgba(237, 106, 69, ${0.55 * strength})`
  context.lineWidth = Math.max(3, cellSize * 0.12)
  context.strokeRect(
    context.lineWidth / 2,
    context.lineWidth / 2,
    cssWidth - context.lineWidth,
    cssHeight - context.lineWidth,
  )
  context.restore()
}

// Queued attacks sit above the stack as charging chips — one per block, as
// wide as the slab it will drop — so the defender can see what is coming and
// how long they have to answer it.
function drawTelegraphQueue(
  context: CanvasRenderingContext2D,
  state: SimulationState,
  cssWidth: number,
  cellSize: number,
  reducedMotion: boolean,
): void {
  if (state.incomingGarbage.length === 0) return

  const chips: { width: number; height: number; type: string; charge: number }[] =
    []
  for (const attack of state.incomingGarbage) {
    const remaining = Math.max(0, attack.readyAt - state.elapsedMs)
    const charge =
      1 -
      Math.min(
        1,
        remaining / defaultGameConfig.timing.garbageTelegraphMs,
      )
    for (const block of attack.blocks) {
      chips.push({ ...block, charge })
      if (chips.length >= 6) break
    }
    if (chips.length >= 6) break
  }

  const gap = cellSize * 0.1
  const height = cellSize * 0.3
  const top = cellSize * 0.12
  // Chips are sized in board columns so a slab's chip is as wide as the slab,
  // but the row is scaled down once the queue asks for more than a board's
  // worth — otherwise a full-width attack, or several at once, would overflow.
  const requestedUnits = chips.reduce((sum, chip) => sum + chip.width, 0)
  const available = cssWidth - gap * (chips.length + 1)
  const unit = available / Math.max(requestedUnits, state.board.columns)
  let x = gap

  for (const chip of chips) {
    const width = Math.max(cellSize * 0.3, unit * chip.width)
    const isMetal = chip.type === 'metal'
    const radius = height * 0.36
    const ready = chip.charge >= 1
    const pulse =
      ready && !reducedMotion
        ? (1 + Math.sin(state.elapsedMs / 90)) / 2
        : 0

    context.save()
    // Empty shell, then the charge fills it left to right.
    roundedRect(context, x, top, width, height, radius)
    context.fillStyle = 'rgba(110, 86, 72, 0.16)'
    context.fill()

    context.save()
    roundedRect(context, x, top, width, height, radius)
    context.clip()
    context.fillStyle = isMetal ? '#adc7d8' : '#cfb5a3'
    context.fillRect(x, top, width * chip.charge, height)
    context.fillStyle = 'rgba(255, 250, 245, 0.4)'
    context.fillRect(x, top, width * chip.charge, height * 0.34)
    // A tall slab reads as two stacked bars.
    if (chip.height > 1) {
      context.strokeStyle = 'rgba(110, 86, 72, 0.35)'
      context.lineWidth = Math.max(1, cellSize * 0.02)
      context.beginPath()
      context.moveTo(x, top + height / 2)
      context.lineTo(x + width * chip.charge, top + height / 2)
      context.stroke()
    }
    context.restore()

    roundedRect(context, x, top, width, height, radius)
    context.strokeStyle = ready
      ? `rgba(237, 106, 69, ${0.55 + pulse * 0.45})`
      : 'rgba(110, 86, 72, 0.32)'
    context.lineWidth = Math.max(1.5, cellSize * (ready ? 0.045 : 0.025))
    context.stroke()
    context.restore()

    x += width + gap
  }
}

// Stop time is what makes the stack freeze after a combo, and until now it was
// invisible. The gauge shares the top HUD band with the telegraph queue, where
// it never covers the stack it is holding down.
function drawStopMeter(
  context: CanvasRenderingContext2D,
  state: SimulationState,
  cssWidth: number,
  cellSize: number,
  reducedMotion: boolean,
): void {
  if (state.stopTimeRemainingMs <= 0 || state.status !== 'playing') return

  // Length reads as absolute stop time, so a monster chain visibly buys more
  // than a four-panel combo instead of every stop looking the same.
  const fraction = Math.min(
    1,
    state.stopTimeRemainingMs / defaultGameConfig.timing.maximumStopTimeMs,
  )
  const inset = cellSize * 0.1
  const barHeight = Math.max(5, cellSize * 0.17)
  const top = cellSize * 0.52
  const labelWidth = Math.max(26, cellSize * 0.6)
  const barX = inset + labelWidth
  const trackWidth = cssWidth - inset - barX
  const radius = barHeight / 2
  const expiring = state.stopTimeRemainingMs < 600
  const flash =
    expiring && !reducedMotion
      ? 0.45 + 0.55 * ((1 + Math.sin(state.elapsedMs / 55)) / 2)
      : 1

  context.save()
  context.globalAlpha = flash

  context.font = `800 ${Math.max(9, cellSize * 0.16)}px "Nunito", system-ui`
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.fillStyle = '#d95832'
  context.fillText('STOP', inset, top + barHeight / 2)

  roundedRect(context, barX, top, trackWidth, barHeight, radius)
  context.fillStyle = 'rgba(110, 86, 72, 0.16)'
  context.fill()

  const fillWidth = Math.max(barHeight, trackWidth * fraction)
  roundedRect(context, barX, top, fillWidth, barHeight, radius)
  const fill = context.createLinearGradient(0, top, 0, top + barHeight)
  fill.addColorStop(0, expiring ? '#ff9a6e' : '#ffd15c')
  fill.addColorStop(1, expiring ? '#ed6a45' : '#ff914f')
  context.fillStyle = fill
  context.fill()
  context.restore()
}

export function drawBoard(
  canvas: HTMLCanvasElement,
  state: SimulationState,
  options: DrawBoardOptions,
): void {
  const context = canvas.getContext('2d')
  if (context === null) return

  const bounds = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(bounds.width * dpr))
  const height = Math.max(1, Math.round(bounds.height * dpr))

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  const cssWidth = bounds.width
  const cssHeight = bounds.height
  const cellSize = cssWidth / state.board.columns
  context.clearRect(0, 0, cssWidth, cssHeight)

  context.fillStyle = '#fff4e8'
  context.fillRect(0, 0, cssWidth, cssHeight)

  const sprites = panelSpritesFor(cellSize, dpr)
  const impact = options.impact ?? null
  const panic = options.panic ?? 0

  // Everything that belongs to the well — grid, garbage, panels, cursor, the
  // rise and danger lines — rides the shake together. The background fill above
  // stays put so no gap opens at the edges, and the badges and overlays drawn
  // after the restore stay readable while the board is thrashing.
  context.save()
  if (!options.reducedMotion) {
    const shake =
      impact === null
        ? { x: 0, y: 0 }
        : shakeOffset(impact, state.elapsedMs)
    // A steady tremble under panic, on top of any landing shake.
    const tremble = panic * 0.012
    const trembleX =
      tremble === 0 ? 0 : Math.sin(state.elapsedMs * 0.031) * tremble
    const trembleY =
      tremble === 0 ? 0 : Math.sin(state.elapsedMs * 0.047) * tremble
    context.translate(
      (shake.x + trembleX) * cellSize,
      (shake.y + trembleY) * cellSize,
    )
  }

  context.strokeStyle = 'rgba(196, 120, 80, 0.1)'
  context.lineWidth = 1
  context.beginPath()
  for (let column = 1; column < state.board.columns; column += 1) {
    context.moveTo(column * cellSize, 0)
    context.lineTo(column * cellSize, cssHeight)
  }
  for (let row = 1; row < state.board.visibleRows; row += 1) {
    context.moveTo(0, row * cellSize)
    context.lineTo(cssWidth, row * cellSize)
  }
  context.stroke()

  for (const block of state.garbage) {
    const visualRow =
      block.state === 'falling'
        ? block.row - block.fallProgress
        : block.row
    const x = block.column * cellSize
    const y =
      cssHeight -
      (visualRow + block.height + state.riseOffset) * cellSize
    const width = block.width * cellSize
    const height = block.height * cellSize

    // Squash on impact: the slab flattens against the stack and springs back,
    // pinned to its own bottom edge so it never overlaps what it landed on.
    const landedAt = impact?.landings.get(block.id)
    const squashAge =
      landedAt === undefined ? Number.POSITIVE_INFINITY : state.elapsedMs - landedAt
    const squashing =
      !options.reducedMotion && squashAge >= 0 && squashAge < SQUASH_DURATION_MS

    if (squashing) {
      const progress = squashAge / SQUASH_DURATION_MS
      const amount = Math.sin(progress * Math.PI) * (1 - progress) * 0.26
      context.save()
      context.translate(x + width / 2, y + height)
      context.scale(1 + amount * 0.5, 1 - amount)
      context.translate(-(x + width / 2), -(y + height))
    }
    drawGarbageBlock(
      context,
      block,
      x,
      y,
      width,
      height,
      cellSize,
      options.reducedMotion,
      state.elapsedMs,
    )
    if (squashing) context.restore()
  }

  const incomingY = cssHeight - state.riseOffset * cellSize
  for (
    let column = 0;
    column < state.board.incomingRow.length;
    column += 1
  ) {
    const type = state.board.incomingRow[column]!
    const x = column * cellSize

    context.globalAlpha = 0.45
    drawPanelSprite(context, sprites, type, 'incoming', x, incomingY)
    context.globalAlpha = 1
  }

  const popIndexes = state.clears.length > 0 ? popOrder(state) : null

  for (const row of state.board.cells) {
    for (const panel of row) {
      if (panel === null || panel.row >= state.board.visibleRows) continue

      const phaseProgress =
        panel.animationStartedAt === null
          ? 1
          : Math.min(
              1,
              (state.elapsedMs - panel.animationStartedAt) /
                (panel.state === 'swapping' ? 100 : 300),
            )
      const swapOffset =
        panel.state === 'swapping'
          ? panel.offsetX * cellSize * phaseProgress
          : 0
      const x = panel.column * cellSize + swapOffset
      let y =
        cssHeight -
        (panel.row + 1 + state.riseOffset) * cellSize
      // Panels are placed in their landing cell the instant gravity runs, so
      // the drop is played back here: lift the panel to where it fell from and
      // let it come down, then bounce.
      const fall =
        options.reducedMotion || panel.state !== 'idle'
          ? undefined
          : impact?.panelFalls.get(panel.id)
      let landingSquash = 0
      if (fall !== undefined) {
        const visual = panelFallVisual(fall, state.elapsedMs)
        y -= visual.riseCells * cellSize
        landingSquash = visual.squash
      }
      let flashing =
        panel.state === 'flashing' &&
        !options.reducedMotion &&
        Math.floor((state.elapsedMs - (panel.animationStartedAt ?? 0)) / 70) % 2 ===
          0
      let alpha = 1
      // Scale applied around the panel's centre as it pops.
      let popScale = 1

      if (panel.state === 'clearing') {
        const popIndex = popIndexes?.get(panel.id) ?? 0
        const popStart =
          (panel.animationStartedAt ?? state.elapsedMs) +
          popIndex * defaultGameConfig.timing.panelPopIntervalMs
        const popElapsed = state.elapsedMs - popStart

        if (popElapsed < 0) {
          // Waiting its turn: hold the white flash so the queue reads as
          // "these are all going".
          flashing = !options.reducedMotion
        } else {
          const popProgress = Math.min(
            1,
            popElapsed / defaultGameConfig.timing.clearDurationMs,
          )
          alpha = Math.max(0.12, 1 - popProgress)
          if (!options.reducedMotion) {
            // A quick swell before it collapses.
            popScale =
              1 + Math.sin(Math.min(1, popProgress * 1.6) * Math.PI) * 0.16
          }
        }
      }

      // A cell handed over by a breaking garbage block: it bursts out of the
      // slab rather than simply appearing where the tile used to be.
      const revealAge =
        panel.state === 'garbage-locked' && panel.animationStartedAt !== null
          ? state.elapsedMs - panel.animationStartedAt
          : null
      const revealing =
        revealAge !== null &&
        revealAge >= 0 &&
        revealAge < GARBAGE_REVEAL_MS &&
        !options.reducedMotion
      const revealProgress = revealing
        ? (revealAge as number) / GARBAGE_REVEAL_MS
        : 1
      if (revealing) {
        popScale *= 0.74 + 0.26 * revealProgress ** 0.5
      }

      if (alpha !== 1) context.globalAlpha = alpha
      if (popScale !== 1) {
        context.save()
        context.translate(x + cellSize / 2, y + cellSize / 2)
        context.scale(popScale, popScale)
        context.translate(-(x + cellSize / 2), -(y + cellSize / 2))
      }
      if (landingSquash > 0) {
        // Pinned to the cell's bottom edge so the panel never sinks into
        // whatever it landed on.
        context.save()
        context.translate(x + cellSize / 2, y + cellSize)
        context.scale(1 + landingSquash * 0.45, 1 - landingSquash)
        context.translate(-(x + cellSize / 2), -(y + cellSize))
      }
      drawPanelSprite(
        context,
        sprites,
        panel.type,
        flashing ? 'flashing' : 'idle',
        x,
        y,
      )
      if (revealing) {
        // Flash fading off the new panel, plus the shell of the tile it broke
        // out of expanding away.
        const fade = 1 - revealProgress
        context.save()
        roundedRect(
          context,
          x + cellSize * 0.075,
          y + cellSize * 0.075,
          cellSize * 0.85,
          cellSize * 0.85,
          cellSize * 0.26,
        )
        context.fillStyle = `rgba(255, 252, 246, ${0.8 * fade})`
        context.fill()

        const shell = cellSize * (0.5 + revealProgress * 0.34)
        context.beginPath()
        context.rect(
          x + cellSize / 2 - shell,
          y + cellSize / 2 - shell,
          shell * 2,
          shell * 2,
        )
        context.strokeStyle = `rgba(255, 209, 92, ${0.7 * fade})`
        context.lineWidth = Math.max(1.5, cellSize * 0.05 * fade)
        context.stroke()
        context.restore()
      } else if (panel.state === 'garbage-locked') {
        // Still owned by the block until the whole row is released.
        context.save()
        roundedRect(
          context,
          x + cellSize * 0.075,
          y + cellSize * 0.075,
          cellSize * 0.85,
          cellSize * 0.85,
          cellSize * 0.26,
        )
        context.fillStyle = 'rgba(255, 250, 245, 0.22)'
        context.fill()
        context.restore()
      }

      if (landingSquash > 0) context.restore()
      if (popScale !== 1) context.restore()
      if (alpha !== 1) context.globalAlpha = 1
    }
  }

  if (options.selected !== null) {
    const x = options.selected.column * cellSize
    const y =
      cssHeight -
      (options.selected.row + 1 + state.riseOffset) * cellSize
    context.strokeStyle = '#fffaf5'
    context.lineWidth = Math.max(3, cellSize * 0.065)
    roundedRect(
      context,
      x + cellSize * 0.04,
      y + cellSize * 0.04,
      cellSize * 0.92,
      cellSize * 0.92,
      cellSize * 0.2,
    )
    context.stroke()
  }

  if (options.cursor != null) {
    // The signature two-wide box: a dark outline under a bright one so it
    // stays readable over any panel colour, breathing gently in place.
    const breathe = options.reducedMotion
      ? 0
      : Math.sin(state.elapsedMs / 260) * cellSize * 0.018
    const x = options.cursor.column * cellSize - breathe
    const y =
      cssHeight -
      (options.cursor.row + 1 + state.riseOffset) * cellSize -
      breathe
    const width = cellSize * 2 + breathe * 2
    const height = cellSize + breathe * 2
    const radius = cellSize * 0.22

    context.save()
    context.lineJoin = 'round'
    roundedRect(context, x, y, width, height, radius)
    context.strokeStyle = 'rgba(110, 86, 72, 0.62)'
    context.lineWidth = Math.max(6, cellSize * 0.135)
    context.stroke()
    context.strokeStyle = '#fffaf5'
    context.lineWidth = Math.max(3, cellSize * 0.07)
    context.stroke()

    // Corner ticks, so the two halves read as one grabbing cursor.
    context.strokeStyle = 'rgba(237, 106, 69, 0.9)'
    context.lineWidth = Math.max(2, cellSize * 0.05)
    context.lineCap = 'round'
    const tick = cellSize * 0.18
    for (const [cornerX, cornerY, dirX, dirY] of [
      [x, y, 1, 1],
      [x + width, y, -1, 1],
      [x, y + height, 1, -1],
      [x + width, y + height, -1, -1],
    ] as const) {
      context.beginPath()
      context.moveTo(cornerX + dirX * radius, cornerY + dirY * tick * 0.2)
      context.lineTo(cornerX + dirX * (radius + tick), cornerY)
      context.stroke()
    }
    context.restore()
  }

  const riseY = cssHeight - state.riseOffset * cellSize
  context.save()
  context.strokeStyle = 'rgba(237, 106, 69, 0.34)'
  context.lineWidth = 2
  context.setLineDash([cellSize * 0.14, cellSize * 0.11])
  context.beginPath()
  context.moveTo(0, riseY - 1)
  context.lineTo(cssWidth, riseY - 1)
  context.stroke()
  context.restore()

  if (state.dangerRemainingMs !== null && state.status !== 'lost') {
    context.save()
    context.strokeStyle = 'rgba(240, 96, 108, 0.35)'
    context.lineWidth = 2
    context.setLineDash([cellSize * 0.17, cellSize * 0.12])
    context.beginPath()
    context.moveTo(0, cellSize)
    context.lineTo(cssWidth, cellSize)
    context.stroke()
    context.restore()
  }

  context.restore()

  drawPanicTint(
    context,
    panic,
    state.elapsedMs,
    cssWidth,
    cssHeight,
    cellSize,
    options.reducedMotion,
  )

  drawTelegraphQueue(
    context,
    state,
    cssWidth,
    cellSize,
    options.reducedMotion,
  )

  drawStopMeter(
    context,
    state,
    cssWidth,
    cellSize,
    options.reducedMotion,
  )

  drawComboEffect(
    context,
    state,
    cssWidth,
    cssHeight,
    cellSize,
    options.reducedMotion,
  )

  if (state.dangerRemainingMs !== null && state.status !== 'lost') {
    const dangerY = cellSize
    context.save()
    const labelWidth = Math.min(cssWidth * 0.62, cellSize * 3.4)
    const labelHeight = Math.max(25, cellSize * 0.48)
    roundedRect(
      context,
      (cssWidth - labelWidth) / 2,
      dangerY - labelHeight / 2,
      labelWidth,
      labelHeight,
      labelHeight / 2,
    )
    context.fillStyle = 'rgba(255, 250, 245, 0.92)'
    context.fill()
    context.fillStyle = '#f0606c'
    context.font = `800 ${Math.max(11, cellSize * 0.21)}px "Nunito", system-ui`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(
      `DANGER · ${(state.dangerRemainingMs / 1000).toFixed(1)}s`,
      cssWidth / 2,
      dangerY,
    )
    context.restore()
  }

  if (state.status === 'paused' || state.status === 'lost') {
    context.fillStyle = 'rgba(110, 86, 72, 0.66)'
    context.fillRect(0, 0, cssWidth, cssHeight)
    context.fillStyle = '#fffaf5'
    context.font = `600 ${Math.max(22, cellSize * 0.48)}px "Fredoka", system-ui`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(
      state.status === 'lost' ? 'TOP OUT' : 'PAUSED',
      cssWidth / 2,
      cssHeight / 2,
    )
  }
}
