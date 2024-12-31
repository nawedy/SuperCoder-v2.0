import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { AIModel } from '../../types/database';

interface ModelSelectorProps {
  models: AIModel[];
  selectedModel: AIModel | null;
  onModelSelect: (model: AIModel) => void;
}

export default function ModelSelector({ models, selectedModel, onModelSelect }: ModelSelectorProps) {
  return (
    <div className="relative">
      <button
        className="flex items-center gap-2 bg-gray-800 px-4 py-2 rounded-lg text-white hover:bg-gray-700"
        onClick={() => document.getElementById('model-selector')?.click()}
      >
        <span>{selectedModel?.name || 'Select Model'}</span>
        <ChevronDown className="h-4 w-4" />
      </button>
      <select
        id="model-selector"
        className="absolute opacity-0 w-full h-full top-0 left-0 cursor-pointer"
        value={selectedModel?.id || ''}
        onChange={(e) => {
          const model = models.find(m => m.id === e.target.value);
          if (model) onModelSelect(model);
        }}
      >
        <option value="" disabled>Select Model</option>
        {models.map(model => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
}