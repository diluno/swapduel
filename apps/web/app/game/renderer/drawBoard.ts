import type {
  PanelType,
  SimulationState,
} from '@swapduel/game-engine'

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

interface DrawBoardOptions {
  selected: { row: number; column: number } | null
  reducedMotion: boolean
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

export function drawBoard(
  canvas: HTMLCanvasElement,
  state: SimulationState,
  options: DrawBoardOptions,
): void {
  const context = canvas.getContext('2d')
  if (context === null) return

  const bounds = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
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

  context.strokeStyle = 'rgba(196, 120, 80, 0.1)'
  context.lineWidth = 1
  for (let column = 1; column < state.board.columns; column += 1) {
    context.beginPath()
    context.moveTo(column * cellSize, 0)
    context.lineTo(column * cellSize, cssHeight)
    context.stroke()
  }
  for (let row = 1; row < state.board.visibleRows; row += 1) {
    context.beginPath()
    context.moveTo(0, row * cellSize)
    context.lineTo(cssWidth, row * cellSize)
    context.stroke()
  }

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
    const inset = cellSize * 0.045

    context.save()
    context.shadowColor =
      block.type === 'metal'
        ? 'rgba(107, 182, 242, 0.3)'
        : 'rgba(110, 86, 72, 0.2)'
    context.shadowBlur =
      block.state === 'falling' ? cellSize * 0.18 : cellSize * 0.08
    roundedRect(
      context,
      x + inset,
      y + inset,
      width - inset * 2,
      height - inset * 2,
      cellSize * 0.16,
    )
    context.fillStyle =
      block.type === 'metal' ? '#9fbcd1' : '#c9b4a5'
    context.fill()
    context.strokeStyle =
      block.type === 'metal'
        ? 'rgba(255, 255, 255, 0.82)'
        : 'rgba(255, 244, 232, 0.72)'
    context.lineWidth = Math.max(1.5, cellSize * 0.04)
    context.stroke()

    context.strokeStyle =
      block.type === 'metal'
        ? 'rgba(78, 120, 150, 0.28)'
        : 'rgba(110, 86, 72, 0.24)'
    context.lineWidth = Math.max(1, cellSize * 0.025)
    for (let column = 1; column < block.width; column += 1) {
      context.beginPath()
      context.moveTo(x + column * cellSize, y + inset)
      context.lineTo(x + column * cellSize, y + height - inset)
      context.stroke()
    }
    for (let row = 1; row < block.height; row += 1) {
      context.beginPath()
      context.moveTo(x + inset, y + row * cellSize)
      context.lineTo(x + width - inset, y + row * cellSize)
      context.stroke()
    }

    if (block.state === 'converting') {
      const conversionY = y + (block.height - 1) * cellSize
      context.fillStyle = 'rgba(95, 208, 160, 0.3)'
      context.fillRect(
        x + inset,
        conversionY + inset,
        width - inset * 2,
        cellSize - inset * 2,
      )
    }
    context.restore()
  }

  const incomingY = cssHeight - state.riseOffset * cellSize
  for (
    let column = 0;
    column < state.board.incomingRow.length;
    column += 1
  ) {
    const type = state.board.incomingRow[column]!
    const x = column * cellSize
    const inset = cellSize * 0.075

    context.save()
    context.globalAlpha = 0.45
    context.filter = 'saturate(0.7)'
    context.shadowColor = PANEL_COLORS[type].bottom
    context.shadowBlur = cellSize * 0.08
    drawPanelSurface(context, type, x, incomingY, cellSize, inset)
    drawSymbol(
      context,
      type,
      x + cellSize / 2,
      incomingY + cellSize / 2,
      cellSize,
    )
    context.restore()
  }

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
      const y =
        cssHeight -
        (panel.row + 1 + state.riseOffset) * cellSize
      const inset = cellSize * 0.075
      const flashing =
        panel.state === 'flashing' &&
        !options.reducedMotion &&
        Math.floor((state.elapsedMs - (panel.animationStartedAt ?? 0)) / 70) % 2 ===
          0
      const alpha =
        panel.state === 'clearing' ? Math.max(0.12, 1 - phaseProgress) : 1

      context.save()
      context.globalAlpha = alpha
      context.shadowColor = PANEL_COLORS[panel.type].top
      context.shadowBlur = panel.state === 'flashing' ? cellSize * 0.25 : 0
      drawPanelSurface(
        context,
        panel.type,
        x,
        y,
        cellSize,
        inset,
        flashing,
      )
      if (!flashing) {
        drawSymbol(
          context,
          panel.type,
          x + cellSize / 2,
          y + cellSize / 2,
          cellSize,
        )
      }
      context.restore()
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
    const dangerY = cellSize
    context.save()
    context.strokeStyle = 'rgba(240, 96, 108, 0.35)'
    context.lineWidth = 2
    context.setLineDash([cellSize * 0.17, cellSize * 0.12])
    context.beginPath()
    context.moveTo(0, dangerY)
    context.lineTo(cssWidth, dangerY)
    context.stroke()

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
