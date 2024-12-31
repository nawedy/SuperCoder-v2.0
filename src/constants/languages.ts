export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'العربية' },
  { code: 'am', name: 'አማርኛ' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'hi', name: 'हिन्दी' }
] as const;

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];