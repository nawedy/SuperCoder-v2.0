import { supabase } from './supabase';
import type { Profile, AIModel, UserAPIKey, ChatSession, ChatMessage } from '../types/database';

export async function getProfile(): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .single();
  
  if (error) throw error;
  return data;
}

export async function updateProfile(profile: Partial<Profile>): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(profile)
    .eq('id', profile.id)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

export async function getAIModels(): Promise<AIModel[]> {
  const { data, error } = await supabase
    .from('ai_models')
    .select('*')
    .order('name');
  
  if (error) throw error;
  return data;
}

export async function saveAPIKey(modelId: string, apiKey: string): Promise<void> {
  const { error } = await supabase
    .from('user_api_keys')
    .upsert({
      model_id: modelId,
      api_key: apiKey,
      user_id: (await supabase.auth.getUser()).data.user?.id
    });
  
  if (error) throw error;
}

export async function createChatSession(modelId: string): Promise<ChatSession> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      model_id: modelId,
      title: 'New Chat',
      user_id: (await supabase.auth.getUser()).data.user?.id
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

export async function saveChatMessage(
  sessionId: string,
  content: string,
  role: 'user' | 'assistant'
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      session_id: sessionId,
      content,
      role
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}