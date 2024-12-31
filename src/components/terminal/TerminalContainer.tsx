import React, { useState } from 'react';
import TerminalPrompt from './TerminalPrompt';
import TerminalOutput from './TerminalOutput';
import type { TerminalCommand } from '../../types/terminal';

export default function TerminalContainer() {
  const [history, setHistory] = useState<TerminalCommand[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleCommand = async (command: string) => {
    setIsProcessing(true);
    const newCommand: TerminalCommand = {
      id: crypto.randomUUID(),
      input: command,
      output: '',
      timestamp: new Date().toISOString(),
    };

    setHistory(prev => [...prev, newCommand]);

    // TODO: Integrate with actual command processing
    setTimeout(() => {
      setHistory(prev => 
        prev.map(cmd => 
          cmd.id === newCommand.id 
            ? { ...cmd, output: `Processed command: ${command}` }
            : cmd
        )
      );
      setIsProcessing(false);
    }, 1000);
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white font-mono">
      <TerminalOutput history={history} />
      <TerminalPrompt onSubmit={handleCommand} disabled={isProcessing} />
    </div>
  );
}