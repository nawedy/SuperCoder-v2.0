import React, { useEffect, useRef } from 'react';
import type { ChatMessage as ChatMessageType } from '../../types/database';
import ChatMessage from './ChatMessage';

interface ChatWindowProps {
  messages: ChatMessageType[];
}

export default function ChatWindow({ messages }: ChatWindowProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto space-y-4 p-4">
      {messages.length === 0 ? (
        <div className="text-center text-gray-400 mt-8">
          Start a conversation by typing a message below
        </div>
      ) : (
        messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}