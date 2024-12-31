import React, { useEffect, useRef } from 'react';
import type { TerminalCommand } from '../../types/terminal';

interface TerminalOutputProps {
  history: TerminalCommand[];
}

export default function TerminalOutput({ history }: TerminalOutputProps) {
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [history]);

  return (
    <div ref={outputRef} className="flex-1 overflow-y-auto p-2 space-y-2">
      {history.map((command) => (
        <div key={command.id}>
          <div className="flex items-center">
            <span className="text-emerald-500 mr-2">$</span>
            <span>{command.input}</span>
          </div>
          {command.output && (
            <div className="mt-1 text-gray-300 pl-4">{command.output}</div>
          )}
        </div>
      ))}
    </div>
  );
}