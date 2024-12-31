import React, { useState } from 'react';
import { Key } from 'lucide-react';
import { saveAPIKey } from '../../lib/api';
import type { AIModel, UserAPIKey } from '../../types/database';

interface APIKeySettingsProps {
  models: AIModel[];
  userKeys: UserAPIKey[];
  onSave: (key: UserAPIKey) => void;
}

export default function APIKeySettings({ models, userKeys, onSave }: APIKeySettingsProps) {
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedModel || !apiKey.trim()) return;

    setSaving(true);
    try {
      await saveAPIKey(selectedModel, apiKey);
      setApiKey('');
      setSelectedModel('');
    } catch (error) {
      console.error('Failed to save API key:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-xl font-semibold text-white mb-6">API Keys</h2>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="flex items-center gap-2 text-gray-300 mb-2">
            <Key className="h-4 w-4" />
            Select Model
          </label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">Select a model</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="flex items-center gap-2 text-gray-300 mb-2">
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full bg-gray-700 text-white rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>

        <button
          type="submit"
          disabled={saving || !selectedModel || !apiKey.trim()}
          className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 text-white rounded-lg px-4 py-2"
        >
          {saving ? 'Saving...' : 'Add API Key'}
        </button>
      </form>

      <div className="mt-6">
        <h3 className="text-lg font-medium text-white mb-4">Saved API Keys</h3>
        <div className="space-y-2">
          {userKeys.map((key) => {
            const model = models.find(m => m.id === key.model_id);
            return (
              <div key={key.id} className="flex items-center justify-between bg-gray-700 p-3 rounded-lg">
                <span className="text-white">{model?.name}</span>
                <span className="text-gray-400">•••••••••••••••</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}