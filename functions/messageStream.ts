import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const userId = user.id;
    let lastMessageId = null;
    let isConnectionOpen = true;

    // Create a readable stream for SSE
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        // Send initial connection message
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', userId })}\n\n`));

        // Poll for new messages and push to stream
        const checkForMessages = async () => {
          if (!isConnectionOpen) return;
          
          try {
            const messages = await base44.entities.Message.filter({
              receiver_id: userId,
              read: false
            }, '-created_date', 5);

            if (messages.length > 0) {
              const latestMessage = messages[0];
              
              // Only send if this is a new message
              if (latestMessage.id !== lastMessageId) {
                lastMessageId = latestMessage.id;
                
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'new_message',
                  message: {
                    id: latestMessage.id,
                    sender_id: latestMessage.sender_id,
                    sender_name: latestMessage.sender_name,
                    content: latestMessage.content,
                    created_date: latestMessage.created_date,
                    conversation_id: latestMessage.conversation_id
                  },
                  unreadCount: messages.length
                })}\n\n`));
              }
            }
          } catch (error) {
            console.error('Error checking messages:', error);
          }
        };

        // Check immediately
        await checkForMessages();

        // Then check every 3 seconds
        const interval = setInterval(checkForMessages, 3000);

        // Keep connection alive with heartbeat every 30 seconds
        const heartbeat = setInterval(() => {
          if (isConnectionOpen) {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          }
        }, 30000);

        // Clean up on close (after 5 minutes to prevent zombie connections)
        setTimeout(() => {
          isConnectionOpen = false;
          clearInterval(interval);
          clearInterval(heartbeat);
          controller.close();
        }, 300000); // 5 minutes max connection time
      },
      cancel() {
        isConnectionOpen = false;
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*'
      }
    });

  } catch (error) {
    console.error('SSE Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});