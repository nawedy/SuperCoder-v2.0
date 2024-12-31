import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export default function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2" dir="auto">
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        disabled={disabled}
        placeholder={t('chat.placeholder')}
        className="flex-1 bg-gray-800 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      <button
        type="submit"
        disabled={disabled || !message.trim()}
        className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg px-4 py-2 flex items-center gap-2 text-white"
      >
        <Send className="h-4 w-4" />
        {t('chat.send')}
      </button>
    </form>
  );
}