import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export function useLanguageDirection() {
  const { i18n } = useTranslation();
  
  const direction = useMemo(() => {
    const rtlLanguages = ['ar'];
    return rtlLanguages.includes(i18n.language) ? 'rtl' : 'ltr';
  }, [i18n.language]);

  return {
    direction,
    isRTL: direction === 'rtl'
  };
}