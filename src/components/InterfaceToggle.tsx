import React from 'react';
import { Terminal, MessageSquare } from 'lucide-react';

interface InterfaceToggleProps {
  mode: 'chat' | 'terminal';
  onChange: (mode: 'chat' | 'terminal') => void;
}

export default function InterfaceToggle({ mode, onChange }: InterfaceToggleProps) {
  return (
    <div className="flex bg-gray-800 p-1 rounded-lg">
      <button
        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
          mode === 'chat'
            ? 'bg-emerald-600 text-white'
            : 'text-gray-400 hover:text-white'
        }`}
        onClick={() => onChange('chat')}
      >
        <MessageSquare className="h-4 w-4" />
        Chat
      </button>
      <button
        className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
          mode === 'terminal'
            ? 'bg-emerald-600 text-white'
            : 'text-gray-400 hover:text-white'
        }`}
        onClick={() => onChange('terminal')}
      >
        <Terminal className="h-4 w-4" />
        Terminal
      </button>
    </div>
  );
}