import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { supabase } from '../lib/supabase';

export function useLanguage() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const updateUserLanguage = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase
          .from('profiles')
          .update({ language_preference: i18n.language })
          .eq('id', user.id);
        
        if (error) {
          console.error('Failed to update language preference:', error);
        }
      }
    };

    updateUserLanguage();
  }, [i18n.language]);

  return {
    currentLanguage: i18n.language,
    changeLanguage: i18n.changeLanguage,
    t: i18n.t,
  };
}