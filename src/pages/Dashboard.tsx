import React, { useState } from 'react';
import ChatContainer from '../components/chat/ChatContainer';
import TerminalContainer from '../components/terminal/TerminalContainer';
import InterfaceToggle from '../components/interface/InterfaceToggle';
import { GCPAIService } from '../ai/gcp-ai-service';

export default function Dashboard() {
  const [interfaceMode, setInterfaceMode] = useState<'chat' | 'terminal'>('chat');
  const aiService = useAIService(); // New hook for AI service

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-6xl mx-auto p-6 h-[calc(100vh-4rem)]">
        <div className="mb-4 flex justify-end">
          <InterfaceToggle mode={interfaceMode} onChange={setInterfaceMode} />
        </div>
        <div className="bg-gray-800 rounded-lg h-[calc(100%-3rem)]">
          {interfaceMode === 'chat' ? (
            <ChatContainer aiService={aiService} />
          ) : (
            <TerminalContainer aiService={aiService} />
          )}
        </div>
      </div>
    </div>
  );
}