import React, { useState, useEffect } from 'react';
import { getAIModels } from '../../lib/api';
import ChatWindow from './ChatWindow';
import ChatInput from './ChatInput';
import ModelSelector from '../model/ModelSelector';
import InterfaceToggle from '../interface/InterfaceToggle';
import type { AIModel, ChatMessage } from '../../types/database';

export default function ChatContainer() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(null);
  const [interfaceMode, setInterfaceMode] = useState<'chat' | 'terminal'>('chat');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const loadModels = async () => {
      try {
        const availableModels = await getAIModels();
        setModels(availableModels);
        setSelectedModel(availableModels.find(m => m.is_default) || null);
      } catch (error) {
        console.error('Failed to load models:', error);
      }
    };
    loadModels();
  }, []);

  const handleSendMessage = async (content: string) => {
    if (!selectedModel) return;

    setIsProcessing(true);
    const newUserMessage: ChatMessage = {
      id: crypto.randomUUID(),
      content,
      role: 'user',
      session_id: '', // This would be set when integrated with backend
      created_at: new Date().toISOString()
    };

    setMessages(prev => [...prev, newUserMessage]);

    // TODO: Integrate with actual AI processing
    // For now, simulate a response
    setTimeout(() => {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        content: `Processing your request: ${content}`,
        role: 'assistant',
        session_id: '',
        created_at: new Date().toISOString()
      };
      setMessages(prev => [...prev, assistantMessage]);
      setIsProcessing(false);
    }, 1000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center p-4 border-b border-gray-700">
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onModelSelect={setSelectedModel}
        />
        <InterfaceToggle mode={interfaceMode} onChange={setInterfaceMode} />
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col">
        <ChatWindow messages={messages} />
        <div className="p-4 border-t border-gray-700">
          <ChatInput onSend={handleSendMessage} disabled={isProcessing || !selectedModel} />
        </div>
      </div>
    </div>
  );
}