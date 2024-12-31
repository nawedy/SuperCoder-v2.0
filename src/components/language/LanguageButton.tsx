import React from 'react';
import LanguageIcon from './LanguageIcon';

interface LanguageButtonProps {
  code: string;
  name: string;
  selected?: boolean;
  onClick: () => void;
}

export default function LanguageButton({ code, name, selected, onClick }: LanguageButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
        selected
          ? 'bg-emerald-600 text-white'
          : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
      }`}
    >
      <LanguageIcon code={code} size={16} />
      <span>{name}</span>
    </button>
  );
}