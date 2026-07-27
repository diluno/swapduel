import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Server as SocketIoServer } from 'socket.io'
import WebSocket from 'ws'
import {
  createNativeWebSocketTransport,
  type NativeWebSocketTransport,
} from '../src/realtime/native-websocket'
import { RealtimeHub } from '../src/realtime/realtime-hub'

describe('native WebSocket transport', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close()
  })

  it('upgrades /native and returns versioned event and response frames', async () => {
    const httpServer = createServer()
    const io = new SocketIoServer(httpServer)
    const hub = new RealtimeHub()
    let transport: NativeWebSocketTransport
    transport = createNativeWebSocketTransport({
      httpServer,
      hub,
      getClientAddress: () => 'test-client',
      onRequest: (context) => {
        hub.emitToConnection(context.connectionId, 'room:state', {
          roomId: 'room-1',
        })
        context.respond({
          ok: true,
          data: { accepted: context.request.event },
        })
      },
      onDisconnect: () => {},
    })
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve)
    })
    cleanup.push(
      () => new Promise<void>((resolve) => transport.close(resolve)),
      () => new Promise<void>((resolve) => io.close(() => resolve())),
    )
    const address = httpServer.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address.')
    }

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/native`)
    cleanup.unshift(async () => {
      if (client.readyState === WebSocket.CLOSED) return
      client.close()
      await once(client, 'close')
    })
    await once(client, 'open')
    const framesPromise = new Promise<unknown[]>((resolve) => {
      const frames: unknown[] = []
      client.on('message', (data) => {
        frames.push(JSON.parse(String(data)))
        if (frames.length === 2) resolve(frames)
      })
    })
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: 'request',
      requestId: 'request-1',
      event: 'match:start',
      payload: { roomId: 'room-1' },
    }))

    const [first, second] = await framesPromise

    expect(first).toEqual({
      protocolVersion: 1,
      type: 'event',
      event: 'room:state',
      payload: { roomId: 'room-1' },
    })
    expect(second).toEqual({
      protocolVersion: 1,
      type: 'response',
      requestId: 'request-1',
      result: {
        ok: true,
        data: { accepted: 'match:start' },
      },
    })
  })
})
