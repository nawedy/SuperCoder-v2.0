/*
  # Initial Schema Setup

  1. New Tables
    - `profiles`
      - User profile information and preferences
    - `subscriptions`
      - User subscription details
    - `ai_models`
      - Available AI models
    - `user_api_keys`
      - User's API keys for different models
    - `chat_sessions`
      - Store chat history and context
    - `chat_messages`
      - Individual messages within sessions

  2. Security
    - Enable RLS on all tables
    - Add policies for user data access
*/

-- Profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  email text NOT NULL,
  full_name text,
  avatar_url text,
  two_factor_enabled boolean DEFAULT false,
  interface_preference text DEFAULT 'chat',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) NOT NULL,
  plan_type text NOT NULL CHECK (plan_type IN ('free', 'pro', 'enterprise')),
  status text NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- AI Models table
CREATE TABLE IF NOT EXISTS ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  provider text NOT NULL,
  description text,
  api_key_required boolean DEFAULT true,
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- User API Keys table
CREATE TABLE IF NOT EXISTS user_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) NOT NULL,
  model_id uuid REFERENCES ai_models(id) NOT NULL,
  api_key text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, model_id)
);

-- Chat Sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES profiles(id) NOT NULL,
  title text NOT NULL,
  model_id uuid REFERENCES ai_models(id) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Chat Messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES chat_sessions(id) NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can read their own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can read their own subscriptions"
  ON subscriptions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Everyone can read AI models"
  ON ai_models FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can manage their API keys"
  ON user_api_keys FOR ALL
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can manage their chat sessions"
  ON chat_sessions FOR ALL
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can manage their chat messages"
  ON chat_messages FOR ALL
  TO authenticated
  USING (session_id IN (
    SELECT id FROM chat_sessions WHERE user_id = auth.uid()
  ));

-- Insert default AI models
INSERT INTO ai_models (name, provider, description, is_default)
VALUES
  ('GPT-4', 'OpenAI', 'Latest GPT-4 model from OpenAI', true),
  ('Claude 2', 'Anthropic', 'Claude 2 from Anthropic', false),
  ('Llama 2', 'Meta', 'Open source Llama 2 model', false),
  ('Qwen', 'Alibaba', 'Qwen language model', false);