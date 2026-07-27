import { describe, expect, it } from 'vitest'
import { RealtimeHub } from '../src/realtime/realtime-hub'

describe('RealtimeHub', () => {
  it('delivers room events across registered transports', () => {
    const delivered: string[] = []
    const hub = new RealtimeHub()
    hub.register('socket:a', (event) => delivered.push(`a:${event}`))
    hub.register('native:b', (event) => delivered.push(`b:${event}`))
    hub.join('socket:a', 'room')
    hub.join('native:b', 'room')

    hub.emitToRoom('room', 'room:state', {})

    expect(delivered).toEqual(['a:room:state', 'b:room:state'])
  })

  it('supports lossy opponent-only delivery and unregister cleanup', () => {
    const delivered: string[] = []
    const hub = new RealtimeHub()
    hub.register('socket:a', (event) => delivered.push(`a:${event}`))
    hub.register('native:b', (event) => delivered.push(`b:${event}`))
    hub.join('socket:a', 'room')
    hub.join('native:b', 'room')

    hub.emitToRoomExcept('room', 'socket:a', 'opponent:snapshot', {})
    hub.unregister('native:b')
    hub.emitToRoom('room', 'match:starting', {})

    expect(delivered).toEqual(['b:opponent:snapshot', 'a:match:starting'])
  })

  it('removes all transport memberships when a room expires', () => {
    const delivered: string[] = []
    const hub = new RealtimeHub()
    hub.register('native:a', (event) => delivered.push(event))
    hub.join('native:a', 'room')
    hub.leaveRoom('room')

    hub.emitToRoom('room', 'room:state', {})

    expect(delivered).toEqual([])
  })
})
