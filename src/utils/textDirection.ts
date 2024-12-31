import { LanguageCode } from '../constants/languages';

const RTL_LANGUAGES: LanguageCode[] = ['ar'];
const MIXED_DIRECTION_LANGUAGES: LanguageCode[] = ['am']; // Languages that may contain mixed direction text

export function getTextDirection(language: LanguageCode): 'rtl' | 'ltr' {
  return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
}

export function shouldSupportMixedDirection(language: LanguageCode): boolean {
  return MIXED_DIRECTION_LANGUAGES.includes(language);
}

export function getInputAlignment(language: LanguageCode): 'right' | 'left' {
  return RTL_LANGUAGES.includes(language) ? 'right' : 'left';
}