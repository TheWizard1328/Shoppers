/**
 * Real-time Sync WebSocket Server
 * 
 * Handles WebSocket connections for instant data synchronization
 * across all connected devices/users for Delivery and AppUser entities.
 * 
 * Clients connect and receive broadcasts when:
 * - Deliveries are created, updated, or deleted
 * - AppUser status/location changes
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// In-memory store for connected clients
// Note: In production with multiple isolates, use Redis or similar
const connectedClients = new Map();

// Broadcast to all connected clients except sender
const broadcast = (message, excludeClientId = null) => {
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  
  connectedClients.forEach((ws, clientId) => {
    if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(messageStr);
        sentCount++;
      } catch (error) {
        console.error(`Failed to send to client ${clientId}:`, error);
        // Remove dead connection
        connectedClients.delete(clientId);
      }
    }
  });
  
  console.log(`📡 [RealtimeSync] Broadcast to ${sentCount} clients:`, message.type, message.entity);
};

// Handle incoming messages from clients
const handleClientMessage = async (ws, clientId, message, base44) => {
  try {
    const data = JSON.parse(message);
    
    switch (data.type) {
      case 'ping':
        // Keepalive response
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
        
      case 'subscribe':
        // Client wants to subscribe to specific entities
        console.log(`📥 [RealtimeSync] Client ${clientId} subscribed to:`, data.entities);
        break;
        
      case 'mutation':
        // Client is broadcasting a mutation they made
        // Relay to all other clients
        broadcast({
          type: 'entity_change',
          entity: data.entity,
          action: data.action, // 'create', 'update', 'delete', 'batch_delete'
          id: data.id,
          ids: data.ids, // For batch operations
          data: data.data,
          timestamp: Date.now(),
          sourceClientId: clientId
        }, clientId);
        break;
        
      default:
        console.warn(`[RealtimeSync] Unknown message type: ${data.type}`);
    }
  } catch (error) {
    console.error(`[RealtimeSync] Error handling message from ${clientId}:`, error);
  }
};

Deno.serve(async (req) => {
  // Check if this is a WebSocket upgrade request
  const upgrade = req.headers.get('upgrade') || '';
  
  if (upgrade.toLowerCase() !== 'websocket') {
    // Regular HTTP request - handle as broadcast trigger
    // This allows other backend functions to trigger broadcasts
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        
        if (body.broadcast) {
          broadcast({
            type: 'entity_change',
            entity: body.entity,
            action: body.action,
            id: body.id,
            ids: body.ids,
            data: body.data,
            timestamp: Date.now()
          });
          
          return Response.json({ 
            success: true, 
            message: `Broadcast sent to ${connectedClients.size} clients` 
          });
        }
        
        return Response.json({ 
          success: false, 
          error: 'Invalid request - missing broadcast flag' 
        }, { status: 400 });
        
      } catch (error) {
        return Response.json({ 
          success: false, 
          error: error.message 
        }, { status: 500 });
      }
    }
    
    // GET request - return connection stats
    return Response.json({
      status: 'ok',
      connectedClients: connectedClients.size,
      timestamp: Date.now()
    });
  }
  
  // WebSocket upgrade
  const { socket, response } = Deno.upgradeWebSocket(req);
  
  // Generate unique client ID
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Initialize base44 client for auth
  let base44;
  try {
    base44 = createClientFromRequest(req);
  } catch (error) {
    console.warn('[RealtimeSync] Could not create base44 client - proceeding without auth');
  }
  
  socket.onopen = () => {
    connectedClients.set(clientId, socket);
    console.log(`🔗 [RealtimeSync] Client connected: ${clientId} (Total: ${connectedClients.size})`);
    
    // Send welcome message with client ID
    socket.send(JSON.stringify({
      type: 'connected',
      clientId: clientId,
      timestamp: Date.now()
    }));
  };
  
  socket.onmessage = (event) => {
    handleClientMessage(socket, clientId, event.data, base44);
  };
  
  socket.onclose = () => {
    connectedClients.delete(clientId);
    console.log(`🔌 [RealtimeSync] Client disconnected: ${clientId} (Total: ${connectedClients.size})`);
  };
  
  socket.onerror = (error) => {
    console.error(`❌ [RealtimeSync] WebSocket error for ${clientId}:`, error);
    connectedClients.delete(clientId);
  };
  
  return response;
});