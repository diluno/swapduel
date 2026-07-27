export type RealtimeSender = (event: string, payload: unknown) => void

/**
 * Transport-neutral connection and room delivery.
 *
 * RoomStore deliberately identifies players by connection ID. Keeping the
 * corresponding membership here lets Socket.IO and native WebSocket clients
 * share rooms without either transport needing to understand the other.
 */
export class RealtimeHub {
  private readonly senders = new Map<string, RealtimeSender>()
  private readonly roomMembers = new Map<string, Set<string>>()
  private readonly connectionRooms = new Map<string, Set<string>>()

  register(connectionId: string, sender: RealtimeSender): void {
    this.unregister(connectionId)
    this.senders.set(connectionId, sender)
    this.connectionRooms.set(connectionId, new Set())
  }

  unregister(connectionId: string): void {
    const rooms = this.connectionRooms.get(connectionId)
    if (rooms !== undefined) {
      for (const roomId of rooms) {
        const members = this.roomMembers.get(roomId)
        members?.delete(connectionId)
        if (members?.size === 0) this.roomMembers.delete(roomId)
      }
    }
    this.connectionRooms.delete(connectionId)
    this.senders.delete(connectionId)
  }

  join(connectionId: string, roomId: string): void {
    if (!this.senders.has(connectionId)) {
      throw new Error(`Realtime connection ${connectionId} is not registered.`)
    }
    let members = this.roomMembers.get(roomId)
    if (members === undefined) {
      members = new Set()
      this.roomMembers.set(roomId, members)
    }
    members.add(connectionId)
    this.connectionRooms.get(connectionId)?.add(roomId)
  }

  leaveRoom(roomId: string): void {
    const members = this.roomMembers.get(roomId)
    if (members === undefined) return
    for (const connectionId of members) {
      this.connectionRooms.get(connectionId)?.delete(roomId)
    }
    this.roomMembers.delete(roomId)
  }

  emitToConnection(
    connectionId: string,
    event: string,
    payload: unknown,
  ): void {
    this.senders.get(connectionId)?.(event, payload)
  }

  emitToRoom(roomId: string, event: string, payload: unknown): void {
    this.emitToRoomExcept(roomId, null, event, payload)
  }

  emitToRoomExcept(
    roomId: string,
    excludedConnectionId: string | null,
    event: string,
    payload: unknown,
  ): void {
    const members = this.roomMembers.get(roomId)
    if (members === undefined) return
    for (const connectionId of members) {
      if (connectionId === excludedConnectionId) continue
      this.emitToConnection(connectionId, event, payload)
    }
  }
}
