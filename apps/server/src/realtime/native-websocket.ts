import { randomUUID } from 'node:crypto'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import {
  nativeRequestSchema,
  PROTOCOL_VERSION,
  type NativeRequest,
  type RoomError,
} from '@swapduel/contracts'
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from 'ws'
import type { RealtimeHub } from './realtime-hub'

export const NATIVE_WEBSOCKET_PATH = '/native'

export interface NativeRequestContext {
  connectionId: string
  clientAddress: string
  request: NativeRequest
  respond: (result: unknown) => void
}

export interface NativeWebSocketTransportOptions {
  httpServer: HttpServer
  hub: RealtimeHub
  getClientAddress: (request: IncomingMessage) => string
  onRequest: (context: NativeRequestContext) => void
  onDisconnect: (connectionId: string) => void
}

export interface NativeWebSocketTransport {
  close: (callback?: () => void) => void
}

function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame)
}

function sendRoomError(socket: WebSocket, error: RoomError): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    type: 'event',
    event: 'room:error',
    payload: error,
  }))
}

function parseRequest(data: RawData, isBinary: boolean): NativeRequest | null {
  if (isBinary) return null
  try {
    const decoded: unknown = JSON.parse(data.toString())
    const parsed = nativeRequestSchema.safeParse(decoded)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function createNativeWebSocketTransport(
  options: NativeWebSocketTransportOptions,
): NativeWebSocketTransport {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  })

  options.httpServer.on('upgrade', (request, socket, head) => {
    let pathname = ''
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      return
    }
    if (pathname !== NATIVE_WEBSOCKET_PATH) return
    server.handleUpgrade(request, socket, head, (webSocket) => {
      server.emit('connection', webSocket, request)
    })
  })

  server.on('connection', (socket, request) => {
    const connectionId = `native:${randomUUID()}`
    const clientAddress = options.getClientAddress(request)

    options.hub.register(connectionId, (event, payload) => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(encodeFrame({
        protocolVersion: PROTOCOL_VERSION,
        type: 'event',
        event,
        payload,
      }))
    })

    socket.on('message', (data, isBinary) => {
      const nativeRequest = parseRequest(data, isBinary)
      if (nativeRequest === null) {
        sendRoomError(socket, {
          code: 'INVALID_REQUEST',
          message: 'The WebSocket message was invalid.',
        })
        return
      }

      options.onRequest({
        connectionId,
        clientAddress,
        request: nativeRequest,
        respond: (result) => {
          if (socket.readyState !== WebSocket.OPEN) return
          socket.send(encodeFrame({
            protocolVersion: PROTOCOL_VERSION,
            type: 'response',
            requestId: nativeRequest.requestId,
            result,
          }))
        },
      })
    })

    socket.once('close', () => {
      options.onDisconnect(connectionId)
      options.hub.unregister(connectionId)
    })
  })

  return {
    close(callback) {
      for (const client of server.clients) client.close(1001)
      server.close(callback)
    },
  }
}
