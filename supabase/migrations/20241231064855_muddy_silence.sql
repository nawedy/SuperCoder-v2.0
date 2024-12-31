/*
  # Add language support

  1. Changes
    - Add language_preference to profiles table
    - Add supported_languages to ai_models table
    - Add language column to chat_sessions and chat_messages tables
  
  2. Security
    - Maintain existing RLS policies
    - No breaking changes to existing data
*/

-- Add language_preference to profiles
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'profiles' AND column_name = 'language_preference'
  ) THEN
    ALTER TABLE profiles ADD COLUMN language_preference text DEFAULT 'en';
  END IF;
END $$;

-- Add supported_languages to ai_models
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'ai_models' AND column_name = 'supported_languages'
  ) THEN
    ALTER TABLE ai_models ADD COLUMN supported_languages text[] DEFAULT ARRAY['en'];
  END IF;
END $$;

-- Add language to chat_sessions
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_sessions' AND column_name = 'language'
  ) THEN
    ALTER TABLE chat_sessions ADD COLUMN language text DEFAULT 'en';
  END IF;
END $$;

-- Add language to chat_messages
DO $$ 
BEGIN 
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat_messages' AND column_name = 'language'
  ) THEN
    ALTER TABLE chat_messages ADD COLUMN language text DEFAULT 'en';
  END IF;
END $$;

-- Update existing AI models with supported languages
UPDATE ai_models 
SET supported_languages = ARRAY['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'hi', 'ar', 'am']
WHERE supported_languages = ARRAY['en'];