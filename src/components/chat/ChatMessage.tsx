import React from 'react';
import { User, Bot } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '../../types/database';

interface ChatMessageProps {
  message: ChatMessageType;
}

export default function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  
  return (
    <div 
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
      dir="auto"
    >
      <div className="flex-shrink-0">
        {isUser ? (
          <div className="w-8 h-8 bg-emerald-600 rounded-full flex items-center justify-center">
            <User className="w-5 h-5 text-white" />
          </div>
        ) : (
          <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center">
            <Bot className="w-5 h-5 text-white" />
          </div>
        )}
      </div>
      <div 
        className={`flex-1 px-4 py-2 rounded-lg ${
          isUser ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-100'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}