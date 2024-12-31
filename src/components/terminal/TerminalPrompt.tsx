import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TerminalPromptProps {
  onSubmit: (command: string) => void;
  disabled?: boolean;
}

export default function TerminalPrompt({ onSubmit, disabled }: TerminalPromptProps) {
  const [command, setCommand] = useState('');
  const { t } = useTranslation();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (command.trim() && !disabled) {
      onSubmit(command.trim());
      setCommand('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-2 border-t border-gray-700" dir="auto">
      <div className="flex items-center">
        <span className="text-emerald-500 mr-2">$</span>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={disabled}
          className="flex-1 bg-transparent focus:outline-none"
          placeholder={t('terminal.placeholder')}
        />
      </div>
    </form>
  );
}