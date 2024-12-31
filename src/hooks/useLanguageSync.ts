import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { getTextDirection } from '../utils/textDirection';

export function useLanguageSync() {
  const { i18n } = useTranslation();

  useEffect(() => {
    // Update document direction
    document.documentElement.dir = getTextDirection(i18n.language as any);
    
    // Update user preference in database
    const updateUserLanguage = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({ 
            language_preference: i18n.language,
            updated_at: new Date().toISOString()
          })
          .eq('id', user.id);
      }
    };

    updateUserLanguage();
  }, [i18n.language]);

  return {
    direction: getTextDirection(i18n.language as any),
    language: i18n.language
  };
}