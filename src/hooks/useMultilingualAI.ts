import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import type { AIModel } from '../types/database';

export function useMultilingualAI() {
  const { i18n } = useTranslation();

  const getAvailableModels = async () => {
    const { data, error } = await supabase
      .from('ai_models')
      .select('*')
      .contains('supported_languages', [i18n.language]);

    if (error) throw error;
    return data as AIModel[];
  };

  const processMessage = async (
    modelId: string,
    content: string,
    sessionId: string
  ) => {
    // Store message with current language
    const { error } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        content,
        role: 'user',
        language: i18n.language
      });

    if (error) throw error;

    // TODO: Process with AI model
    // This is where you'd integrate with your AI processing logic
  };

  return {
    getAvailableModels,
    processMessage,
    currentLanguage: i18n.language
  };
}