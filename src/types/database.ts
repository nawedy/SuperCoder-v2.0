export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  two_factor_enabled: boolean;
  interface_preference: 'chat' | 'terminal';
  language_preference: string;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  plan_type: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'cancelled' | 'expired';
  current_period_start: string;
  current_period_end: string;
  created_at: string;
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  description: string | null;
  api_key_required: boolean;
  is_default: boolean;
  supported_languages: string[];
  created_at: string;
}

export interface UserAPIKey {
  id: string;
  user_id: string;
  model_id: string;
  api_key: string;
  created_at: string;
}

export interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  model_id: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  language: string;
  created_at: string;
}