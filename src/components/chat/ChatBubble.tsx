import React from 'react';
import { User, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getTextDirection } from '../../utils/textDirection';
import type { ChatMessage } from '../../types/database';

interface ChatBubbleProps {
  message: ChatMessage;
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const { i18n } = useTranslation();
  const isUser = message.role === 'user';
  const direction = getTextDirection(i18n.language as any);
  
  return (
    <div 
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}
      dir={direction}
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