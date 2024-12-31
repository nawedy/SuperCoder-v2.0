import React from 'react';

interface LanguageIconProps {
  code: string;
  size?: number;
}

export default function LanguageIcon({ code, size = 20 }: LanguageIconProps) {
  const getFlagEmoji = (langCode: string) => {
    const flags: Record<string, string> = {
      en: '🇬🇧',
      ar: '🇸🇦',
      am: '🇪🇹',
      es: '🇪🇸',
      fr: '🇫🇷',
      de: '🇩🇪',
      zh: '🇨🇳',
      ja: '🇯🇵',
      ko: '🇰🇷',
      hi: '🇮🇳'
    };
    return flags[langCode] || '🌐';
  };

  return (
    <span style={{ fontSize: `${size}px` }} className="inline-block">
      {getFlagEmoji(code)}
    </span>
  );
}