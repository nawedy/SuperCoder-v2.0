import type { LanguageCode } from '../constants/languages';

export function getLanguageDirection(code: LanguageCode): 'ltr' | 'rtl' {
  return ['ar'].includes(code) ? 'rtl' : 'ltr';
}

export function getLanguageName(code: LanguageCode, displayLanguage: LanguageCode = 'en'): string {
  const names: Record<LanguageCode, Record<LanguageCode, string>> = {
    en: { en: 'English', ar: 'الإنجليزية', am: 'እንግሊዝኛ' },
    ar: { en: 'Arabic', ar: 'العربية', am: 'አረብኛ' },
    am: { en: 'Amharic', ar: 'الأمهرية', am: 'አማርኛ' },
    // Add more language names as needed
  };

  return names[code]?.[displayLanguage] || names[code]?.['en'] || code;
}